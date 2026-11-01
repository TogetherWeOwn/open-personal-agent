// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The chat loads nothing from another origin (ADR 0010 D7).
test.beforeEach(async ({ page, baseURL }) => {
  page.on("request", (req) => expect(new URL(req.url()).origin).toBe(baseURL));
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: { onboarded: true } }));
});

/** Tabs to the composer, types, presses Enter and waits for the whole reply. */
async function sendByKeyboard(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message" });
  for (let i = 0; i < 10 && !(await box.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("a word at a time.");
}

test("a keyboard-only send streams a reply and announces it", async ({ page }) => {
  await page.goto("/");
  await sendByKeyboard(page, "Plan my week");
  await expect(page.getByRole("main").getByRole("heading")).toHaveText("Plan my week");
  await expect(page.getByRole("status")).toContainText("Assistant replied: ");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
});

test("an unhealthy server shows an alert; a draft stays with its chat", async ({ page }) => {
  await page.route("/api/health", (route) =>
    route.fulfill({ status: 503, json: { status: "degraded" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("isn't responding properly");
  await page.getByRole("textbox", { name: "Message" }).fill("Draft for the first chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await page.getByRole("option").last().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Draft for the first chat",
  );
});

test("Stop ends a reply", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill("Write an essay");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("log")).toContainText("Stopped before it finished.");
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1280]) {
    test(`chat, ${colorScheme}, ${width} px: axe clean, no sideways scroll, baseline`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.goto("/");
      if (width < 640) {
        // Phones open on the list; a conversation fills the screen and "Chats" goes back.
        await expect(page.getByRole("main")).toBeHidden();
        await page.getByRole("option", { name: "New chat" }).click();
        await expect(page.getByRole("complementary")).toBeHidden();
      }
      await sendByKeyboard(page, "Plan my week");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
      await expect(page).toHaveScreenshot(`chat-${colorScheme}-${width}.png`);
      if (width < 640) {
        await page.getByRole("button", { name: "Chats" }).click();
        await expect(page.getByRole("option", { name: "Plan my week" })).toBeVisible();
      }
    });
  }
}
