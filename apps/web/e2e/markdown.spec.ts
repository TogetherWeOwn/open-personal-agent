// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { MOCK_HOSTILE } from "../src/chat/mock-transport";

// M3-10 AC3, R7 M3-7: hostile model output makes zero requests to other hosts and runs no script.
test.beforeEach(async ({ page }) => {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: { onboarded: true } }));
});

test("Copy code says so when the browser refuses the clipboard", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied"));
  });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill(MOCK_HOSTILE);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(page.getByRole("button", { name: /Couldn't copy/ })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`hostile Markdown, ${colorScheme}, ${width} px: no remote request, no script, axe clean`, async ({
      page,
      context,
      baseURL,
    }) => {
      const offsite: string[] = [];
      context.on("request", (req) => {
        if (new URL(req.url()).origin !== baseURL) offsite.push(req.url());
      });
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.goto("/");
      if (width < 640) await page.getByRole("option", { name: "New chat" }).click();
      await page.getByRole("textbox", { name: "Message" }).fill(MOCK_HOSTILE);
      await page.keyboard.press("Enter");
      const log = page.getByRole("log", { name: "Messages" });
      await expect(log.getByRole("button", { name: "Copy code" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(offsite).toEqual([]);
      expect(await page.evaluate(() => "pwned" in window)).toBe(false);

      // Remote images are links, unsafe links are text, and raw HTML never became elements.
      await expect(
        log.getByRole("link", { name: /Image: evil\.example\/pixel\.png/ }),
      ).toBeVisible();
      await expect(log.getByText("click me")).not.toHaveAttribute("href");
      // Scoped to the reply itself: the run's timeline above it (M3-09) carries its own icons.
      const reply = log.getByText("Assistant", { exact: true }).locator("xpath=..");
      expect(await reply.locator("img, svg, script, iframe, object, embed").count()).toBe(0);
      await expect(log.getByRole("region", { name: "Table" })).toBeVisible();

      // Following a `javascript:` attempt does nothing; the page stays put.
      await log.getByText("click me").click();
      await page.waitForLoadState("networkidle");
      expect(await page.evaluate(() => "pwned" in window)).toBe(false);
      expect(offsite).toEqual([]);

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
    });
  }
}
