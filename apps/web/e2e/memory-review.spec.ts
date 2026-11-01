// SPDX-License-Identifier: Apache-2.0
// Waiting for you, export and Settings › Memory (M3-15 AC2, AC4, AC5; m3-ux §3.7, §3.9).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-GB", timezoneId: "Europe/London" });

const DAY = 86_400_000;
const NOW = Date.now();

const base = {
  kind: "fact",
  trust: "user",
  op: "create",
  source: "chat",
  sourceRef: null,
  sourceExcerpt: null,
  conversation: null,
  createdAt: NOW - 3 * DAY,
  lastUsedAt: null,
  expiresAt: null,
};
const leeds = { ...base, id: "n1", text: "Sam lives in Leeds" };
const fromWeb = {
  ...base,
  trust: "external",
  source: "web",
  sourceRef: "https://example.com/news",
  sourceExcerpt: "Sam moved to Paris last spring",
  createdAt: NOW - 5 * DAY,
};
const conflict = {
  ...fromWeb,
  id: "p1",
  text: "Sam lives in Paris",
  op: "update",
  expiresAt: NOW + 9 * DAY + 3_600_000,
  targets: [leeds],
};
const fresh = {
  ...fromWeb,
  id: "p2",
  text: "Likes jazz",
  expiresAt: NOW + 3_600_000,
  targets: [],
};

interface Stub {
  learn: boolean;
  decisions: string[];
}

async function stub(page: Page): Promise<Stub> {
  const state: Stub = { learn: true, decisions: [] };
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) =>
    route.fulfill({
      json: { onboarded: true, providers: [], roles: { chat: null, background: null } },
    }),
  );
  await page.route("/api/settings/memory", async (route) => {
    if (route.request().method() === "PUT") {
      state.learn = (route.request().postDataJSON() as { learnFromChats: boolean }).learnFromChats;
    }
    await route.fulfill({ json: { learnFromChats: state.learn } });
  });
  await page.route("/api/memory**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/memory/proposals") {
      const open = [conflict, fresh].filter(
        (p) => !state.decisions.some((d) => d.startsWith(p.id)),
      );
      return route.fulfill({ json: { expired: 0, proposals: open } });
    }
    if (path.startsWith("/api/memory/proposals/")) {
      const [, , , , id, decision] = path.split("/");
      state.decisions.push(`${id}:${decision}`);
      return decision === "reject"
        ? route.fulfill({ status: 204 })
        : route.fulfill({ json: { memory: { ...conflict, op: "update" } } });
    }
    if (path === "/api/memory/export") {
      return route.fulfill({
        headers: { "content-disposition": 'attachment; filename="memory.opa-memory.json"' },
        json: { format: "opa-memory-export/v1", memories: [] },
      });
    }
    const accepted = state.decisions.includes("p1:accept");
    return route.fulfill({
      json: { memories: [accepted ? { ...leeds, id: "p1", text: "Sam lives in Paris" } : leeds] },
    });
  });
  return state;
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

test("shows each suggestion with its source, expiry and a diff, and never applies it alone", async ({
  page,
}) => {
  const state = await stub(page);
  await page.goto("/memory");
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  const change = waiting.getByRole("region", { name: "I'd like to remember: Sam lives in Paris" });
  await expect(change).toContainText("From a web page or file");
  await expect(change).toContainText("Expires in 9 days");
  await expect(change).toContainText("“Sam moved to Paris last spring”");
  await expect(change.getByRole("link", { name: /example\.com/ })).toBeVisible();
  await expect(change).toContainText("removed: Leeds, added: Paris");
  const jazz = waiting.getByRole("region", { name: "I'd like to remember: Likes jazz" });
  await expect(jazz).toContainText("Expires today");
  await expect(jazz.getByRole("button", { name: "Remember this" })).toBeVisible();
  await axe(page);
  expect(state.decisions).toEqual([]);
  await change.getByRole("button", { name: "Use the new one" }).click();
  await expect(change).toBeHidden();
  await expect(page.getByRole("region", { name: "Notes" })).toContainText("Sam lives in Paris");
  expect(state.decisions).toEqual(["p1:accept"]);
});

test("keeps both, or discards with Undo before anything is sent", async ({ page }) => {
  const state = await stub(page);
  await page.goto("/memory/waiting");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Waiting for you");
  await page.getByRole("button", { name: "Don't remember" }).click();
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast).toContainText("Discarded “Likes jazz”.");
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Don't remember" })).toBeVisible();
  await page.getByRole("button", { name: "Keep both" }).click();
  await page.getByRole("button", { name: "Don't remember" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(page.getByText("Nothing is waiting for you.")).toBeVisible();
  expect(state.decisions).toEqual(["p1:keep-both", "p2:reject"]);
  await axe(page);
});

test("exports as Markdown in a sheet and as an opa-memory-export/v1 download", async ({ page }) => {
  await stub(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByRole("menuitem", { name: "View what my assistant knows about me" }).click();
  const sheet = page.getByRole("dialog", { name: "What my assistant knows about me" });
  await expect(sheet.getByRole("heading", { name: "Notes" })).toBeVisible();
  await expect(sheet).toContainText("Sam lives in Leeds (you told me; From a chat;");
  await axe(page);
  await sheet.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Export" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download JSON" }).click();
  expect((await download).suggestedFilename()).toBe("memory.opa-memory.json");
});

test("turns Learn from our chats off, and Memory says so", async ({ page }) => {
  const state = await stub(page);
  await page.goto("/settings/memory");
  const toggle = page.getByRole("switch", { name: "Learn from our chats" });
  await expect(toggle).toBeChecked();
  await axe(page);
  // RAC hides the input itself; a person presses the label.
  await page.locator("label").filter({ hasText: "Learn from our chats" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(toggle).not.toBeChecked();
  expect(state.learn).toBe(false);
  await page.getByRole("link", { name: "Memory", exact: true }).last().click();
  await expect(page.getByText("I'm not saving new memories.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Turn this on in Settings." })).toHaveAttribute(
    "href",
    "/settings/memory",
  );
});

for (const width of [375, 1280]) {
  test(`waiting for you fits ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stub(page);
    await page.goto("/memory");
    await expect(page.getByRole("button", { name: "Use the new one" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await axe(page);
  });
}
