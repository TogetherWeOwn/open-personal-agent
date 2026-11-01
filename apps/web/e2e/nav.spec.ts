// SPDX-License-Identifier: Apache-2.0
// NavShell and the route table (M3-00 AC2–AC4; m3-ux §1.2).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/approvals?status=pending", (route) =>
    route.fulfill({ json: { batches: [] } }),
  );
  // The table serves the real Settings screens, so the stub carries the shape they read.
  await page.route("/api/settings", (route) =>
    route.fulfill({
      json: {
        onboarded: true,
        providers: [],
        roles: { chat: null, background: null, embedding: null },
      },
    }),
  );
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
  ["/approvals/a1", "This request isn't waiting anymore"],
  ["/activity", "Tasks", /\/activity\/tasks$/],
  ["/activity/tasks/t1", "Task"],
  ["/activity/outputs", "Outputs"],
  ["/activity/outputs/o1", "Output"],
  ["/activity/log", "Activity log"],
  ["/memory", "Memory"],
  ["/memory/waiting", "Waiting for you"],
  ["/settings", "Settings"],
  // Models already shipped with a real screen, so the table serves it, not a placeholder.
  // M3-19 ships the Computer and Apps & tools screens the same way.
  ["/settings/models", "Settings"],
  ["/settings/agent-engine", "Settings"],
  ["/settings/computer", "Settings"],
  ["/settings/apps", "Settings"],
  ["/settings/memory", "Settings"],
  // Spending shipped with M3-17; Usage keeps its own address and Spending links to it.
  ["/settings/spending", "Settings"],
  ["/settings/privacy", "Settings"],
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
  const nav = page.getByRole("navigation", { name: "Main" });
  // Shipped Settings screens move focus like every other routed screen.
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(h1(page)).toHaveText("Settings");
  await expect(h1(page)).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await nav.getByRole("link", { name: "Inbox" }).click();
  await expect(h1(page)).toBeFocused();
  await expect(nav.getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/activity\/tasks$/);
  await expect(h1(page)).toHaveText("Tasks");
  await expect(h1(page)).toBeFocused();
  await page.goBack();
  await expect(h1(page)).toHaveText("Inbox");
  await page.goForward();
  await expect(h1(page)).toHaveText("Tasks");
  await page.reload();
  await expect(h1(page)).toHaveText("Tasks");
  await nav.getByRole("link", { name: "Chat" }).click();
  await expect(page).toHaveTitle("Chat · Open Personal Agent");
  await expect(h1(page)).toBeFocused();
});

test("on a phone the tab bar has Chat, Inbox, Activity and You, and hides while typing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "Main" });
  await expect(tabs.getByRole("link")).toHaveText(["Chat", "Inbox", "Activity"]);
  await tabs.getByRole("button", { name: "You" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(h1(page)).toHaveText("Settings");
  await tabs.getByRole("link", { name: "Chat" }).click();
  await page.getByRole("option", { name: "New chat" }).click();
  await page.getByRole("textbox", { name: "Message" }).focus();
  await expect(tabs).toBeHidden();
  await page.getByRole("textbox", { name: "Message" }).blur();
  await expect(tabs).toBeVisible();
});

test("on a tablet the conversation list opens as a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await page.getByRole("button", { name: "Chats" }).click();
  const sheet = page.getByRole("dialog", { name: "Chats" });
  await sheet.getByRole("button", { name: "New chat" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("the account menu switches the theme, and back", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
});

test("a sign out the server refuses stays put and says so", async ({ page }) => {
  await page.route("/api/auth/logout", (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await page.goto("/inbox");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't sign out");
  await expect(page).toHaveURL(/\/inbox$/);
});

test("a sign out on an expired session redirects home", async ({ page }) => {
  await page.route("/api/auth/logout", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthenticated" } }),
  );
  await page.goto("/inbox");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("on a phone the You menu marks the active destination", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/usage");
  const tabs = page.getByRole("navigation", { name: "Main" });
  await tabs.getByRole("button", { name: "You" }).click();
  // RAC's MenuItem doesn't forward aria-current to the DOM, so the active destination is
  // announced with visually-hidden text instead (as with "opens in a new tab" links).
  await expect(page.getByRole("menuitem", { name: "Settings (current page)" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Memory" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Memory (current page)" })).toHaveCount(0);
});

test("in the sidebar, picking a chat from another screen lands on Chat and Back returns", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Conversations" });
  await sidebar.getByRole("button", { name: "New chat" }).click();
  await expect(sidebar.getByRole("option")).toHaveCount(2);
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Inbox" }).click();
  await expect(h1(page)).toHaveText("Inbox");
  // The already-selected conversation is the case a stale press handler used to swallow.
  await sidebar.locator('[role="option"][aria-selected="true"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.goBack();
  await expect(h1(page)).toHaveText("Inbox");
  await sidebar.locator('[role="option"][aria-selected="false"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.goBack();
  await expect(h1(page)).toHaveText("Inbox");
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`nav, ${colorScheme}, ${width} px: every destination is axe clean`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      // chat.spec covers the chat itself, with a conversation open, at every width.
      for (const path of ["/inbox", "/activity/tasks", "/memory", "/settings", "/nope"]) {
        await page.goto(path);
        await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
        await axe(page, width);
      }
      await page.getByRole("button", { name: width < 640 ? "You" : "Account" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await axe(page, width);
    });
  }
}
