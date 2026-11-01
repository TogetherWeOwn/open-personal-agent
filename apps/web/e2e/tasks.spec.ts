// SPDX-License-Identifier: Apache-2.0
// Activity › Tasks (M3-13 AC1-2): a late response for a tab or task the user has already left
// never overwrites the screen, so a slow Now fetch can't swap History's rows out, and a slow
// task fetch can't replace the task the address now names (Stop would then POST the wrong id).
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

const NOW = Date.UTC(2026, 10, 1, 12);

const task = (over: Record<string, unknown>) => ({
  id: "a",
  title: "Slow task A",
  conversationId: "c1",
  conversationTitle: "Chat one",
  kind: "chat",
  mode: "agent",
  status: "running",
  limitKind: null,
  error: null,
  costMicroUsd: 123_400,
  unpricedCalls: 0,
  calls: 3,
  createdAt: NOW - 600_000,
  updatedAt: NOW - 300_000,
  startedAt: NOW - 300_000,
  finishedAt: null,
  ...over,
});

const NOW_ROW = task({ id: "now-1", title: "Now task", status: "running" });
const HISTORY_ROW = task({
  id: "hist-1",
  title: "History task",
  status: "succeeded",
  finishedAt: NOW - 60_000,
});

async function stubShell(page: Page) {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/conversations", (route) =>
    route.fulfill({
      json: { conversations: [{ id: "c1", title: "Chat one", updatedAt: NOW - 600_000 }] },
    }),
  );
}

test("a late Now response doesn't replace the History rows", async ({ page }) => {
  await stubShell(page);
  await page.route(
    (url) => url.pathname === "/api/tasks",
    async (route) => {
      const statuses = new URL(route.request().url()).searchParams.getAll("status");
      if (statuses.includes("queued")) {
        // The Now tab loads slowly; the user switches away before it answers.
        await new Promise((r) => setTimeout(r, 500));
        return route.fulfill({ json: { tasks: [NOW_ROW] } });
      }
      return route.fulfill({ json: { tasks: [HISTORY_ROW] } });
    },
  );

  await page.goto("/activity/tasks");
  await page.getByRole("radio", { name: "History", exact: true }).click();
  await expect(page.getByRole("link", { name: /History task/ })).toBeVisible();
  // Past the Now delay: the late response must not swap History's rows out.
  await page.waitForTimeout(800);
  await expect(page.getByRole("link", { name: /History task/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Now task/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "History", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("a late task response doesn't replace the opened task", async ({ page }) => {
  await stubShell(page);
  let releaseA!: () => void;
  const gatedA = new Promise<void>((r) => {
    releaseA = r;
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/tasks/"),
    async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      if (id === "a") {
        await gatedA;
        return route.fulfill({ json: { task: task({ id: "a", title: "Slow task A" }) } });
      }
      return route.fulfill({ json: { task: task({ id: "b", title: "Fast task B" }) } });
    },
  );

  await page.goto("/activity/tasks/a");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Task");
  // Move to B the way an in-app link does: same screen, new id, A's fetch still in flight.
  await page.evaluate(() => {
    window.history.pushState(null, "", "/activity/tasks/b");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fast task B");
  releaseA();
  await page.waitForTimeout(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fast task B");
});
