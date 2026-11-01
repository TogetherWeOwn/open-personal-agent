// SPDX-License-Identifier: Apache-2.0
// The `ui/` kit and the m3-ux §5.1 tokens: every component, open and closed, passes axe (contrast
// included) in both themes at 375 and 1280 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`kit, ${colorScheme}, ${width} px: axe clean open and closed`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.goto("/__kit");
      await expect(page.getByRole("status").filter({ hasText: "Loading tasks" })).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.getByRole("button", { name: "Worked for 2m · 6 tools · 1 failed" }).click();
      await expect(page.getByText("Fetched three pages.")).toBeVisible();
      await axe(page);

      await page.getByRole("button", { name: "Export" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await axe(page);
      await page.getByRole("menuitem", { name: "JSON" }).click();
      await expect(page.getByText("Picked: JSON")).toBeVisible();

      await page.getByRole("button", { name: "Approve" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete 4 notes?" });
      await expect(dialog).toBeVisible();
      await axe(page);
      // A destructive dialog isn't dismissed by a click outside; Cancel closes it.
      await page.mouse.click(2, 2);
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "Approve" })).toBeFocused();
      // Confirming runs the action and closes the dialog too.
      await page.getByRole("button", { name: "Approve" }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByText("Deleted.")).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name: "Approve" })).toBeFocused();

      await page.getByRole("button", { name: "Task details" }).click();
      const sheet = page.getByRole("dialog", { name: "Compare three pages" });
      await expect(sheet).toBeVisible();
      await axe(page);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    });
  }
}

test("the keyboard focus ring uses its own token, not the accent", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/__kit");
  const primary = page.getByRole("button", { name: "Primary" });
  await expect(primary).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  await expect(primary).toHaveCSS("outline-style", "solid");
  await expect(primary).toHaveCSS("outline-color", "rgb(29, 91, 214)");
  await expect(primary).not.toHaveCSS("background-color", "rgb(29, 91, 214)");
});

test("the tab list moves with the arrow keys", async ({ page }) => {
  await page.goto("/__kit");
  await page.getByRole("tab", { name: "By day" }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "By model" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tabpanel")).toHaveText("gpt-4.1-mini");
});
