// SPDX-License-Identifier: Apache-2.0
// The route table (M3-00 AC3, AC4; m3-ux §1.2).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: { onboarded: true } }));
});

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });

async function axe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

// Every M3 address lands somewhere real; IDs are placeholders until their screens exist.
const PAGES: [path: string, heading: string, url?: RegExp][] = [
  ["/inbox", "Inbox"],
  ["/approvals/a1", "Inbox", /\/inbox$/],
  ["/activity", "Tasks", /\/activity\/tasks$/],
  ["/activity/tasks/t1", "Task"],
  ["/activity/outputs", "Outputs"],
  ["/activity/outputs/o1", "Output"],
  ["/activity/log", "Activity log"],
  ["/memory", "Memory"],
  ["/memory/waiting", "Waiting for you"],
  ["/settings", "Settings"],
  ["/settings/models", "Models"],
  ["/settings/computer", "Computer"],
  ["/settings/spending", "Usage", /\/usage$/],
  ["/usage", "Usage"],
  ["/nope", "This page doesn't exist"],
  ["/settings/nope", "This page doesn't exist"],
  ["/activity/tasks/t1/extra", "This page doesn't exist"],
];

for (const [path, heading, url] of PAGES) {
  test(`${path} shows "${heading}"`, async ({ page }) => {
    await page.goto(path);
    await expect(h1(page)).toHaveText(heading);
    if (url) await expect(page).toHaveURL(url);
    await expect(page).toHaveTitle(`${heading} · Open Personal Agent`);
  });
}

test("an unknown address links back to Chat", async ({ page }) => {
  await page.goto("/no/such/page");
  await page.getByRole("link", { name: "Go to Chat" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("navigation moves focus to the page heading; Back, Forward and reload keep the screen", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Usage" }).click();
  await expect(h1(page)).toHaveText("Usage");
  await expect(h1(page)).toBeFocused();
  await page.goto("/inbox");
  await page.getByRole("link", { name: "See Activity" }).click();
  await expect(page).toHaveURL(/\/activity\/tasks$/);
  await expect(h1(page)).toHaveText("Tasks");
  await expect(h1(page)).toBeFocused();
  await page.goBack();
  await expect(h1(page)).toHaveText("Inbox");
  await page.goForward();
  await expect(h1(page)).toHaveText("Tasks");
  await page.reload();
  await expect(h1(page)).toHaveText("Tasks");
});

test("going back to the chat names it in the title and focuses its heading", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Chat · Open Personal Agent");
  await page.getByRole("link", { name: "Usage" }).click();
  await page.getByRole("link", { name: "Chats" }).click();
  await expect(page).toHaveTitle("Chat · Open Personal Agent");
  await expect(h1(page)).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`placeholders, ${colorScheme}, ${width} px: axe clean`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      for (const path of [
        "/inbox",
        "/activity/tasks",
        "/memory",
        "/settings",
        "/settings/computer",
        "/nope",
      ]) {
        await page.goto(path);
        await expect(h1(page)).toBeVisible();
        await axe(page, width);
      }
    });
  }
}
