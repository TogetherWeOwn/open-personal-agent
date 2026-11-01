// SPDX-License-Identifier: Apache-2.0
// Waiting for you (M3-15 AC2; m3-ux §3.7, Flow C).
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
  decisions: string[];
  /** What the list returns; the conflict and the new fact by default. */
  proposals: Record<string, unknown>[];
  /** The next list request fails, once. */
  listFails?: boolean;
}

async function stub(page: Page): Promise<Stub> {
  const state: Stub = { decisions: [], proposals: [conflict, fresh] };
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/memory**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/memory/proposals") {
      if (state.listFails) {
        state.listFails = false;
        return route.fulfill({ status: 500, json: { error: "internal_error" } });
      }
      const open = state.proposals.filter(
        (p) => !state.decisions.some((d) => d.startsWith(p.id as string)),
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

test("a change to a note edited since offers to add it as a new note", async ({ page }) => {
  const state = await stub(page);
  state.proposals = [{ ...conflict, targets: [] }];
  await page.goto("/memory/waiting");
  await expect(
    page.getByText("The note this would change was edited or deleted since."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Use the new one" })).toBeHidden();
  await page.getByRole("button", { name: "Remember this" }).click();
  await expect.poll(() => state.decisions).toEqual(["p1:keep-both"]);
});

test("keeping a note a suggestion would forget names the note in the toast", async ({ page }) => {
  const state = await stub(page);
  state.proposals = [{ ...fromWeb, id: "p3", text: "", op: "delete", targets: [leeds] }];
  await page.goto("/memory/waiting");
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText(
    "Kept “Sam lives in Leeds”.",
  );
});

test("a failed load offers Try again", async ({ page }) => {
  const state = await stub(page);
  state.listFails = true;
  await page.goto("/memory/waiting");
  await expect(page.getByRole("alert")).toContainText(
    "I couldn't load the suggestions waiting for you.",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Remember this" })).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("leaving the page sends a discard waiting behind Undo", async ({ page }) => {
  const state = await stub(page);
  await page.goto("/memory/waiting");
  await page.getByRole("button", { name: "Don't remember" }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  await expect.poll(() => state.decisions).toEqual(["p2:reject"]);
  await expect(page.getByRole("region", { name: "Notifications" })).toBeHidden();
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
