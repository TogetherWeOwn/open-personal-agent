// SPDX-License-Identifier: Apache-2.0
// The `ui/` kit and the m3-ux §5.1 tokens: every component passes axe (contrast
// included) in both themes at 375 and 1280 px.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`kit, ${colorScheme}, ${width} px: axe clean, no sideways scroll`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.goto("/__kit");
      await expect(page.getByRole("status").filter({ hasText: "Loading tasks" })).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await axe(page);
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
