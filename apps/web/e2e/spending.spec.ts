// SPDX-License-Identifier: Apache-2.0
// Settings › Spending and the spending banners (M3-17 AC2, AC5; m3-ux §3.9, §3.10).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const LIMITS = {
  taskBudgetMicroUsd: 500_000,
  dailyCapMicroUsd: 5_000_000,
  monthlyBudgetMicroUsd: 20_000_000,
  hardCapMicroUsd: null,
};
const spending = (over: Record<string, unknown> = {}) => ({
  settings: LIMITS,
  defaults: LIMITS,
  executionLimits: { callsPerMessage: 8, toolCallsPerMessage: 20, stepsPerTask: 200 },
  todayMicroUsd: 120_000,
  monthMicroUsd: 3_420_000,
  warning: null,
  hardCapReached: false,
  month: Date.UTC(2026, 10, 1),
  userId: "u",
  ...over,
});

async function stub(
  page: Page,
  body: unknown,
  saved: unknown[] = [],
  after: (() => unknown) | null = null,
) {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) =>
    route.fulfill({
      json: {
        onboarded: true,
        providers: [],
        roles: { chat: null, background: null, embedding: null },
      },
    }),
  );
  await page.route("/api/settings/spending", (route) => {
    if (route.request().method() === "PUT") {
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { settings: LIMITS } });
    }
    // After a save, `after` decides what the next reads see.
    const next = saved.length && after ? after() : body;
    return next === "fail" ? route.fulfill({ status: 503 }) : route.fulfill({ json: next });
  });
}

test("shows every limit with its default, and execution limits read-only", async ({ page }) => {
  await stub(page, spending());
  await page.goto("/settings/spending");
  await expect(page.getByRole("heading", { name: "Spending", level: 2 })).toBeVisible();
  await expect(page.getByText("This month: about $3.42 of your $20 budget.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Task budget ($)" })).toHaveValue("0.50");
  await expect(page.getByText("What one task may spend. Default: $0.50.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Daily limit ($)" })).toHaveValue("5.00");
  await expect(page.getByRole("textbox", { name: "Monthly budget ($)" })).toHaveValue("20.00");
  await expect(
    page.getByText("I'll warn you at 50%, 80% and 100%. I won't stop working."),
  ).toBeVisible();
  await expect(page.getByRole("switch", { name: "Hard limit" })).not.toBeChecked();
  await expect(
    page.getByText("Per message: 8 model calls and 20 tool calls. Per task: 200 steps."),
  ).toBeVisible();
  await expect(page.getByText("These can't be changed yet.")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(3); // execution limits have no field
  await expect(page.getByRole("link", { name: "See usage" })).toHaveAttribute("href", "/usage");
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
});

test("saves dollars as micro-USD, turns the hard limit on, and refuses a bad amount", async ({
  page,
}) => {
  const saved: unknown[] = [];
  await stub(page, spending(), saved);
  await page.goto("/settings/spending");
  const task = page.getByRole("textbox", { name: "Task budget ($)" });
  await task.fill("abc");
  await expect(page.getByText("Enter $0.01 to $10,000.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await task.fill("0.10");
  await page.getByText("Hard limit", { exact: true }).click();
  await page.getByRole("textbox", { name: "Hard limit per month ($)" }).fill("30");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  expect(saved).toEqual([
    {
      taskBudgetMicroUsd: 100_000,
      dailyCapMicroUsd: 5_000_000,
      monthlyBudgetMicroUsd: 20_000_000,
      hardCapMicroUsd: 30_000_000,
    },
  ]);
});

test("50% is a quiet line on Spending, not a banner", async ({ page }) => {
  await stub(page, spending({ warning: 50 }));
  await page.goto("/settings/spending");
  await expect(page.getByText("Half of this month's $20 budget used.")).toBeVisible();
  await expect(page.getByText(/You've used|You've reached/)).toHaveCount(0);
});

test("80% and 100% are app-wide banners; each can be dismissed", async ({ page }) => {
  await stub(page, spending({ warning: 80 }));
  await page.goto("/");
  const eighty = page.getByText("You've used 80% of this month's $20 budget.");
  await expect(eighty).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(eighty).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(eighty).toHaveCount(0);

  await page.unrouteAll();
  await stub(page, spending({ warning: 100 }));
  await page.goto("/inbox");
  await expect(
    page.getByText("You've reached this month's $20 budget. I'll keep working."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open Spending" }).click();
  await expect(page).toHaveURL(/\/settings\/spending$/);
});

test("a reached hard limit says background tasks are paused", async ({ page }) => {
  await stub(
    page,
    spending({ settings: { ...LIMITS, hardCapMicroUsd: 30_000_000 }, hardCapReached: true }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Background tasks are paused: this month's $30 hard limit is reached."),
  ).toBeVisible();
  await expect(page.getByRole("switch", { name: "Hard limit" })).toHaveCount(0);
});

test("70% of a Cloudflare allowance is a banner that links to Usage (COST-5)", async ({ page }) => {
  await stub(page, spending({ allowanceWarnings: [{ id: "d1_cap", percent: 72 }] }));
  await page.goto("/");
  await expect(page.getByText("Your database is at 72% of its 10 GB limit.")).toBeVisible();
  await expect(page.getByRole("link", { name: "See usage" })).toHaveAttribute("href", "/usage");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByText("Your database is at 72% of its 10 GB limit.")).toHaveCount(0);
});

test("a saved change clears the banner at once, and a failed refresh isn't called a failed save", async ({
  page,
}) => {
  const saved: unknown[] = [];
  let refresh: unknown = spending();
  await stub(page, spending({ warning: 80 }), saved, () => refresh);
  await page.goto("/settings/spending");
  const banner = page.getByText("You've used 80% of this month's $20 budget.");
  await expect(banner).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);
  refresh = "fail";
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved. Reload to see the updated figures.")).toBeVisible();
});

test("on a phone, the Chats list shows the banners too", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await stub(page, spending({ warning: 80 }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  await expect(page.getByText("You've used 80% of this month's $20 budget.")).toBeVisible();
});

test("a dismissal belongs to the account that made it", async ({ page }) => {
  await stub(page, spending({ warning: 80 }));
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await page.unrouteAll();
  await stub(page, spending({ warning: 80, userId: "someone-else" }));
  await page.reload();
  await expect(page.getByText("You've used 80% of this month's $20 budget.")).toBeVisible();
});

test("a body of another shape shows the load error, not a broken page", async ({ page }) => {
  await stub(page, { settings: { monthlyBudgetMicroUsd: 20_000_000 }, defaults: {} });
  await page.goto("/settings/spending");
  await expect(page.getByRole("alert")).toHaveText("Spending couldn't be loaded. Try again.");
});
