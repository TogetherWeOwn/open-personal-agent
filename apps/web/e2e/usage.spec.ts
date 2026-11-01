// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

const line = (over: Record<string, unknown>) => ({
  calls: 3,
  inputTokens: 12_300,
  outputTokens: 950,
  costSource: "estimated",
  priceVerifiedAt: "2026-11-01",
  stale: false,
  ...over,
});
const period = {
  costMicroUsd: 123_400,
  unpricedCalls: 1,
  groups: [
    {
      providerId: "openai",
      name: "OpenAI",
      label: "Billed by OpenAI",
      billingUrl: "https://platform.openai.com/usage",
      costMicroUsd: 120_000,
      lines: [
        line({ model: "gpt-4.1-mini", name: "GPT-4.1 mini", costMicroUsd: 116_000 }),
        line({
          model: "gpt-4.1",
          name: "GPT-4.1",
          calls: 1,
          costMicroUsd: 4_000,
          priceVerifiedAt: "2026-02-04",
          stale: true,
        }),
      ],
    },
    {
      providerId: "workers-ai",
      name: "Cloudflare: Workers AI",
      label: "Billed by Cloudflare: Workers AI",
      billingUrl: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
      costMicroUsd: 3_400,
      lines: [
        line({
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          name: "Llama 3.3 70B (fast)",
          costMicroUsd: 3_400,
        }),
      ],
    },
    {
      providerId: "my-llm",
      name: "my-llm",
      label: "Billed by my-llm",
      billingUrl: null,
      costMicroUsd: 0,
      lines: [
        line({
          model: "homebrew-7b",
          name: "homebrew-7b",
          calls: 1,
          costMicroUsd: null,
          costSource: null,
          priceVerifiedAt: null,
        }),
      ],
    },
  ],
};
const empty = { costMicroUsd: 0, unpricedCalls: 0, groups: [] };
const allowance = {
  neuronsPerDay: 10_000,
  neuronsUsedHere: 3_200,
  freeNeuronsUsed: 3_200,
  billedNeurons: 0,
  resetsAt: Date.UTC(2026, 10, 2),
};
const none = { status: "none-configured", label: null };
const categories = (today: number, month: number, projected: number) => [
  {
    id: "workers-paid",
    status: "billed",
    label: "Billed by Cloudflare",
    today: null,
    month: 5_000_000,
    projected: 5_000_000,
    priceVerifiedAt: "2026-11-01",
    stale: false,
  },
  { id: "cloudflare", status: "included", label: "Included in Workers Paid" },
  { id: "storage", status: "included", label: "Included in Workers Paid" },
  { id: "ai", status: "billed", label: null, today, month, projected },
  { id: "computers", ...none },
  { id: "connectors", ...none },
  { id: "enhanced", ...none },
];
const days = Array.from({ length: 10 }, (_, i) => ({
  date: `2026-11-${String(i + 1).padStart(2, "0")}`,
  calls: i % 3 === 0 ? 0 : i,
  costMicroUsd: i % 3 === 0 ? 0 : i * 40_000,
  unpricedCalls: 0,
}));
const breakdowns = {
  conversation: [
    { id: "c1", title: "=Plan the trip", calls: 4, costMicroUsd: 3_000_000, unpricedCalls: 0 },
    { id: null, title: null, calls: 2, costMicroUsd: 400_000, unpricedCalls: 1 },
  ],
  task: [
    { id: "t1", title: "Compare flights", calls: 3, costMicroUsd: 2_000_000, unpricedCalls: 0 },
    { id: null, title: null, calls: 3, costMicroUsd: 1_400_000, unpricedCalls: 1 },
  ],
  day: days,
};

function body(today: typeof period, month: typeof period, allowed: unknown = allowance) {
  const projected = month.costMicroUsd * 3;
  return {
    currency: "USD",
    today,
    month,
    projected: { costMicroUsd: projected },
    categories: categories(today.costMicroUsd, month.costMicroUsd, projected),
    breakdowns: month.groups.length ? breakdowns : { conversation: [], task: [], day: [] },
    allowance: allowed,
  };
}

async function open(page: Page, json: unknown) {
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: { onboarded: true } }));
  // The chat stays mounted behind Usage, so its health check runs too.
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  if (json !== undefined) await page.route("/api/usage?*", (route) => route.fulfill({ json }));
  await page.goto("/usage");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Usage");
}

test("leads with today, the month and its projection, then the seven categories", async ({
  page,
}) => {
  await open(page, body(period, { ...period, costMicroUsd: 3_400_000 }));
  const figures = page.locator("dl");
  await expect(figures).toContainText("Todayabout $0.12");
  await expect(figures).toContainText("This monthabout $3.40");
  await expect(figures).toContainText("Projected by month-endabout $10.20");
  const where = page.getByRole("region", { name: "Where it goes" }).getByRole("listitem");
  await expect(where).toHaveCount(7);
  await expect(where.nth(0)).toContainText("$5.00 a monthBilled by Cloudflare, price as of Nov 1");
  await expect(where.nth(1)).toContainText("Included in Workers Paid");
  await expect(where.nth(3)).toContainText("about $3.40 this month");
  await expect(where.nth(4)).toContainText("ComputersComputers your assistant can work on.");
  await expect(where.nth(4)).toContainText("None configured");
  await expect(
    page.getByRole("link", { name: "Check your Cloudflare dashboard (opens in a new tab)" }),
  ).toHaveAttribute("target", "_blank");
});

test("labels every cost by model and flags old and missing prices", async ({ page }) => {
  await open(page, body(period, period));
  const openai = page.getByRole("table", { name: "Billed by OpenAI, this month" });
  await expect(openai.getByRole("row", { name: /GPT-4.1 mini/ })).toContainText(
    "about $0.12estimated, price as of Nov 1, 2026",
  );
  await expect(openai).toContainText("Price last checked Feb 4, 2026. It may have changed.");
  await expect(page.getByRole("table", { name: "Billed by my-llm, this month" })).toContainText(
    "No price on file",
  );
  await expect(page.getByText("< $0.01").first()).toBeVisible();
  await expect(page.getByRole("meter")).toHaveAttribute(
    "aria-valuetext",
    "32% used, resets at 12:00 AM your time",
  );
  await expect(page.getByText("3,200 of 10,000 free today · 0 billed")).toBeVisible();
  const bill = page.getByRole("link", { name: "See your bill at OpenAI (opens in a new tab)" });
  await expect(bill).toHaveAttribute("target", "_blank");
  await page.getByRole("radio", { name: "Today" }).click();
  await expect(page.getByRole("table", { name: "Billed by OpenAI, today" })).toBeVisible();
});

test("breaks the month down by conversation, task and day, and exports each as CSV", async ({
  page,
}) => {
  await open(page, body(period, period));
  await page.getByRole("tab", { name: "Chat" }).click();
  const chats = page.getByRole("table", { name: "By conversation, this month" });
  await expect(chats.getByRole("link", { name: "=Plan the trip" })).toHaveAttribute(
    "href",
    "/c/c1",
  );
  await expect(chats).toContainText("Deleted chats and model tests2about $0.40 + 1 unpriced");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("usage-month-by-conversation.csv");
  const csv = await (await file.createReadStream()).toArray();
  // A title a spreadsheet would run as a formula is quoted out of it.
  expect(Buffer.concat(csv).toString()).toBe(
    "Conversation,Messages,Unpriced messages,Cost (USD)\r\n'=Plan the trip,4,0,3.000000\r\nDeleted chats and model tests,2,1,0.400000\r\n",
  );

  await page.getByRole("tab", { name: "Task" }).click();
  await expect(page.getByRole("link", { name: "Compare flights" })).toHaveAttribute(
    "href",
    "/activity/tasks/t1",
  );
  await page.getByRole("tab", { name: "Day" }).click();
  await expect(
    page.getByRole("img", { name: /^Cost by day this month\. Highest: Nov 9, 2026/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show as table" }).click();
  const byDay = page.getByRole("table", { name: "By day, this month" });
  await expect(byDay.getByRole("row")).toHaveCount(11);
  await expect(byDay.getByRole("row", { name: /Nov 2, 2026/ })).toContainText("1about $0.04");
});

test("nothing used yet still shows the plan; a member has no meter", async ({ page }) => {
  await open(page, body(empty, empty, null));
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Nothing used yet this month" })).toBeVisible();
  await expect(page.getByText("$5.00 a month")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start a chat" })).toHaveAttribute("href", "/");
});

test("a failed load says so and tries again", async ({ page }) => {
  let calls = 0;
  await page.route("/api/usage?*", (route) =>
    ++calls === 1 ? route.fulfill({ status: 500 }) : route.fulfill({ json: body(period, period) }),
  );
  await open(page, undefined);
  await expect(page.getByRole("alert")).toContainText("I couldn't load usage.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("region", { name: "Where it goes" })).toBeVisible();
});

test("going to Settings › Spending and back keeps the chat and its unsent draft", async ({
  page,
}) => {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: { onboarded: true } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  const limits = {
    taskBudgetMicroUsd: 500_000,
    dailyCapMicroUsd: 5_000_000,
    monthlyBudgetMicroUsd: 20_000_000,
    hardCapMicroUsd: null,
  };
  await page.route("/api/settings/spending", (route) =>
    route.fulfill({
      json: {
        settings: limits,
        defaults: limits,
        executionLimits: { callsPerMessage: 8, toolCallsPerMessage: 20, stepsPerTask: 200 },
        todayMicroUsd: 0,
        monthMicroUsd: 0,
        warning: null,
        hardCapReached: false,
        month: Date.UTC(2026, 10, 1),
        userId: "u",
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill("Half a thought");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("link", { name: "Spending" }).click();
  await expect(page.getByRole("heading", { name: "Spending", level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/spending$/);
  await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Half a thought");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Spending", level: 2 })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1280]) {
    test(`usage, ${colorScheme}, ${width} px: axe clean, no sideways scroll, baseline`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await open(page, body(period, period));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
      await expect(page).toHaveScreenshot(`usage-${colorScheme}-${width}.png`, { fullPage: true });
      if (width === 375) {
        // The by-day chart on the narrowest screen: one bar a day still fits.
        await page.getByRole("tab", { name: "Day" }).click();
        const breakdown = page.getByRole("region", { name: "Breakdown" });
        await expect(breakdown).toHaveScreenshot(`usage-day-${colorScheme}-375.png`);
      }
    });
  }
}
