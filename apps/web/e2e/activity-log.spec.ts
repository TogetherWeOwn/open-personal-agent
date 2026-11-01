// SPDX-License-Identifier: Apache-2.0
// Activity › Log (M3-19 AC3, m3-ux §3.8): rows grouped by day, the kind filter and search sent to
// the server, Details with the raw record, paging to the end-of-list line, and the empty states.
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

const NOW = Date.now();
const DAY = 86_400_000;

const row = (id: number, at: number, o: Record<string, unknown>) => ({
  id,
  at,
  kind: "other",
  result: "ok",
  target: null,
  detail: null,
  ...o,
});

const FIRST = [
  row(9, NOW - 60_000, {
    kind: "tools",
    title: "Changed a tool's setting",
    action: "policy.override",
    target: "send_email",
    detail: { tool: "send_email", from: "ask", to: "auto", riskClass: "egress" },
  }),
  row(8, NOW - 120_000, {
    kind: "approvals",
    title: "Stopped an approved action at the last check",
    action: "approval.execute",
    result: "denied",
    target: "b1/a1",
    detail: { reason: "denied_at_recheck" },
  }),
  row(7, NOW - DAY, {
    kind: "approvals",
    title: "Approved an action",
    action: "approval.approve",
    target: "b1/a1",
    detail: { scope: "hour" },
  }),
];
const OLDER = [
  row(3, NOW - 40 * DAY, { kind: "sign_in", title: "Signed in", action: "auth.login" }),
];

async function stubShell(page: Page) {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/conversations", (route) => route.fulfill({ json: { conversations: [] } }));
}

/** Answers like the server, and records each query it was asked. */
async function stubLog(page: Page, asked: URLSearchParams[]) {
  await page.route(
    (url) => url.pathname === "/api/activity/log",
    (route) => {
      const params = new URL(route.request().url()).searchParams;
      asked.push(params);
      const page1 = { entries: FIRST, next: 7, retentionDays: 365 };
      if (params.get("before") === "7")
        return route.fulfill({ json: { entries: OLDER, next: null, retentionDays: 365 } });
      if (params.get("q") === "nothing")
        return route.fulfill({ json: { entries: [], next: null, retentionDays: 365 } });
      if (params.get("kind") === "approvals")
        return route.fulfill({
          json: { entries: FIRST.slice(1), next: null, retentionDays: 365 },
        });
      return route.fulfill({ json: page1 });
    },
  );
}

test("lists rows by day with what changed, pages to the end, and opens Details", async ({
  page,
}) => {
  const asked: URLSearchParams[] = [];
  await stubShell(page);
  await stubLog(page, asked);
  await page.goto("/activity/log");
  await expect(page.getByRole("heading", { level: 1, name: "Activity log" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Yesterday" })).toBeVisible();
  await expect(page.getByText("send_email: Asks you first → Does it without asking")).toBeVisible();
  await expect(page.getByText("Stopped an approved action at the last check")).toBeVisible();
  await expect(page.getByText("Scope: For 1 hour")).toBeVisible();
  await page.screenshot({ path: "test-results/activity-log.png", fullPage: true });

  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.getByText('"riskClass": "egress"')).toBeVisible();

  await expect(page.getByText(/That's everything from the last 365 days/)).toHaveCount(0);
  await page.getByRole("button", { name: "Show older entries" }).click();
  await expect(page.getByText("Signed in")).toBeVisible();
  await expect(page.getByText(/That's everything from the last 365 days/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show older entries" })).toHaveCount(0);
  expect(asked.at(-1)?.get("before")).toBe("7");
});

test("sends the kind filter and the search, and offers a way back from no match", async ({
  page,
}) => {
  const asked: URLSearchParams[] = [];
  await stubShell(page);
  await stubLog(page, asked);
  await page.goto("/activity/log");
  await expect(page.getByText("Scope: For 1 hour")).toBeVisible();

  await page.getByLabel("Show").selectOption("approvals");
  await expect(page.getByText("Scope: For 1 hour")).toBeVisible();
  await expect(page.getByText(/send_email: Asks you first/)).toHaveCount(0);
  expect(asked.at(-1)?.get("kind")).toBe("approvals");

  await page.getByLabel("Show").selectOption("");
  await page.getByRole("searchbox", { name: "Search the log" }).fill("nothing");
  await expect(page.getByText('Nothing matches "nothing".')).toBeVisible();
  await page.getByRole("button", { name: "Show everything" }).click();
  await expect(page.getByText(/send_email: Asks you first/)).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search the log" })).toHaveValue("");
});

test("pages again after the filter changes while older entries load", async ({ page }) => {
  await stubShell(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let older = 0;
  await page.route(
    (url) => url.pathname === "/api/activity/log",
    async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get("before") === "7") {
        // The first older page is still loading when the filter changes.
        if (++older === 1) await held;
        return route.fulfill({ json: { entries: OLDER, next: null, retentionDays: 365 } });
      }
      const entries = params.get("kind") ? FIRST.slice(1) : FIRST;
      return route.fulfill({ json: { entries, next: 7, retentionDays: 365 } });
    },
  );
  await page.goto("/activity/log");
  await page.getByRole("button", { name: "Show older entries" }).click();
  await expect(page.getByRole("button", { name: "Loading older entries…" })).toBeVisible();
  await page.getByLabel("Show").selectOption("approvals");
  await expect(page.getByText(/send_email: Asks you first/)).toHaveCount(0);
  release();
  await page.getByRole("button", { name: "Show older entries" }).click();
  await expect(page.getByText("Signed in")).toBeVisible();
  expect(older).toBe(2);
});

test("says so when nothing has happened, and when the log fails to load", async ({ page }) => {
  await stubShell(page);
  let fail = true;
  await page.route(
    (url) => url.pathname === "/api/activity/log",
    (route) =>
      fail
        ? route.fulfill({ status: 500, json: { error: "boom" } })
        : route.fulfill({ json: { entries: [], next: null, retentionDays: 365 } }),
  );
  await page.goto("/activity/log");
  await expect(page.getByText("I couldn't load the activity log.")).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Nothing has happened yet.")).toBeVisible();
});
