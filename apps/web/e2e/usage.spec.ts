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
  resetsAt: Date.UTC(2026, 10, 2),
};

async function open(page: Page, today: unknown, month: unknown, allowed: unknown = allowance) {
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/usage?*", (route) =>
    route.fulfill({ json: { currency: "USD", today, month, allowance: allowed } }),
  );
  await page.goto("/usage");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Usage");
}

test("leads with the totals, labels every cost and flags old and missing prices", async ({
  page,
}) => {
  await open(page, period, { ...period, costMicroUsd: 3_400_000 });
  await expect(page.getByText("Today: about $0.12 · This month: about $3.40")).toBeVisible();
  const openai = page.getByRole("table", { name: "Billed by OpenAI, today" });
  await expect(openai.getByRole("row", { name: /GPT-4.1 mini/ })).toContainText(
    "about $0.12estimated",
  );
  await expect(openai).toContainText("Price last checked Feb 4, 2026. It may have changed.");
  await expect(page.getByRole("table", { name: "Billed by my-llm, today" })).toContainText(
    "No price on file",
  );
  await expect(page.getByText("< $0.01").first()).toBeVisible();
  await expect(page.getByRole("meter")).toHaveAttribute(
    "aria-valuetext",
    "32% used, resets at 12:00 AM your time",
  );
  const bill = page.getByRole("link", { name: "See your bill at OpenAI (opens in a new tab)" });
  await expect(bill).toHaveAttribute("target", "_blank");
  await page.getByRole("radio", { name: "This month" }).click();
  await expect(page.getByRole("table", { name: "Billed by OpenAI, this month" })).toBeVisible();
});

test("an empty period offers a chat instead of an empty table; a member has no meter", async ({
  page,
}) => {
  await open(page, empty, empty, null);
  await expect(page.getByRole("meter")).toHaveCount(0);
  await expect(page.getByText("No usage yet.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Start a chat" })).toHaveAttribute("href", "/");
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1280]) {
    test(`usage, ${colorScheme}, ${width} px: axe clean, no sideways scroll, baseline`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await open(page, period, period);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
      await expect(page).toHaveScreenshot(`usage-${colorScheme}-${width}.png`, { fullPage: true });
    });
  }
}
