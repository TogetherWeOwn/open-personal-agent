// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Low entropy: the canary allowlist in .gitleaks.toml covers only `*.test.*` files.
const KEY = "test-key-WXYZ";
const model = { kind: "openai-chat", providerId: "openai", baseUrl: "https://api.openai.com/v1" };
const LIMITS = {
  taskBudgetMicroUsd: 500_000,
  dailyCapMicroUsd: 5_000_000,
  monthlyBudgetMicroUsd: 20_000_000,
  hardCapMicroUsd: null,
};
// Settings › Spending's body, as checked; only the budgets show here.
const spending = {
  settings: LIMITS,
  defaults: LIMITS,
  executionLimits: { callsPerMessage: 8, toolCallsPerMessage: 20, stepsPerTask: 200 },
  todayMicroUsd: 0,
  monthMicroUsd: 0,
  warning: null,
  hardCapReached: false,
  month: Date.UTC(2026, 10, 1),
  userId: "u",
};

test("onboarding saves a key, tests it in the same step, and opens the chat with a prompt", async ({
  page,
}) => {
  const bodies: unknown[] = [];
  let onboarded = false;
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") bodies.push(route.request().postDataJSON());
    if (path.endsWith("/onboarded")) onboarded = true;
    if (path.endsWith("/model/test")) {
      return route.fulfill({ json: { ok: true, latencyMs: 412, tools: true, reply: "ready" } });
    }
    const saved = { ...model, model: "gpt-4.1-mini", key: { last4: "WXYZ" } };
    const settings = { displayName: "Owner", about: "", onboarded, model: null };
    if (path.endsWith("/model")) return route.fulfill({ json: { ...settings, model: saved } });
    if (path.endsWith("/spending")) return route.fulfill({ json: spending });
    return route.fulfill(path.endsWith("/settings") ? { json: settings } : { status: 204 });
  });

  await page.goto("/onboarding");
  await expect(page.getByRole("listitem").first()).toHaveText("✓ Claim");
  await page.getByLabel("What should your assistant call you?").fill("Sam");
  await page.getByRole("button", { name: "Continue" }).click();

  const cards = page.getByRole("radiogroup", { name: "How your assistant reaches a model" });
  await expect(cards.getByRole("radio")).toHaveCount(3);
  await expect(cards).toContainText("metered");
  await expect(cards).toContainText("free daily allowance");
  await expect(cards).toContainText("Starter — chat only, add a key for tools");
  // The model step can't be skipped, and Continue waits for a passing test.
  await expect(page.getByRole("button", { name: "Skip for now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
  // A base URL and model typed under "Other" stay behind when the user switches to OpenAI.
  await page.getByText("Other OpenAI-compatible", { exact: true }).click();
  await page.getByLabel("Base URL").fill("https://other.test/v1");
  await page.getByLabel("Model", { exact: true }).fill("other/model");
  await page.getByText("OpenAI", { exact: true }).click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("412 ms to the first word")).toBeVisible();
  await expect(page.getByText("Supported")).toBeVisible();

  // After saving, only the last 4 show, and a blank key field keeps the saved key.
  await expect(page.getByText("Saved key ending in WXYZ.")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save and test" }).click();
  // A change after a passing test isn't what passed: Continue waits for another test.
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByRole("button", { name: "Save and test" }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Costs and limits: the saved budgets, each with Change.
  await expect(page.getByText("Task budget: $0.50 per task")).toBeVisible();
  await expect(page.getByText("Monthly budget: $20")).toBeVisible();
  await page.getByRole("button", { name: "Change task budget" }).click();
  await page.getByLabel("Task budget ($)").fill("1");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "How I ask before acting" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Remember that I'm vegetarian." }).click();
  await page.waitForURL("/");
  // The prompt waits in the composer, not sent.
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Remember that I'm vegetarian.",
  );

  expect(bodies).toContainEqual({ displayName: "Sam", about: "" });
  expect(bodies).toContainEqual({
    ...model,
    kind: "openai-chat",
    model: "gpt-4.1-mini",
    apiKey: KEY,
  });
  expect(bodies).toContainEqual({ ...model, model: "gpt-4.1-mini" });
  expect(bodies).toContainEqual({ taskBudgetMicroUsd: 1_000_000 });
  expect(JSON.stringify(bodies)).not.toContain("other");
  expect(JSON.stringify(bodies)).not.toContain("skip");
});

test("every step but the model can be skipped; a skip is marked, not failed", async ({ page }) => {
  const bodies: unknown[] = [];
  await page.clock.install();
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") bodies.push(route.request().postDataJSON());
    if (path.endsWith("/model/test")) {
      return route.fulfill({ json: { ok: true, latencyMs: 300, tools: false, reply: "ready" } });
    }
    const settings = { displayName: "Owner", about: "", onboarded: false, model: null };
    const starter = { kind: "workers-ai", model: "@cf/meta/llama", key: null };
    if (path.endsWith("/model")) return route.fulfill({ json: { ...settings, model: starter } });
    if (path.endsWith("/setup")) return route.fulfill({ json: { skipped: [], hidden: false } });
    return route.fulfill(path.endsWith("/settings") ? { json: settings } : { status: 204 });
  });

  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("listitem").nth(1)).toHaveText("About you – Skipped");
  await page.getByText("Try without a key", { exact: true }).click();
  await page.getByRole("button", { name: "Save and test" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("listitem").nth(2)).toHaveText("✓ Choose a model");
  await page.getByRole("button", { name: "Skip for now" }).click();

  // Safety: the four lines and the sample card, whose buttons act on nothing. However long the
  // step stays open, the sample never expires.
  const sample = page.getByRole("region", { name: "Send email · Needs your OK" });
  await expect(sample).toBeVisible();
  await page.clock.fastForward("25:00:00");
  await expect(sample).toContainText("Sample");
  await expect(sample).toContainText("sam@example.com");
  await expect(sample).toContainText("This includes text from a web page (a recipe blog)");
  await expect(sample).toContainText("Just this once");
  expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
  await sample.getByRole("button", { name: "Don't allow" }).click();
  await expect(sample.getByRole("status")).toHaveText("That's how it works. Nothing was sent.");
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.waitForURL("/");

  for (const skip of ["about", "costs", "safety", "chat"]) expect(bodies).toContainEqual({ skip });
  expect(bodies).not.toContainEqual(expect.objectContaining({ decision: expect.anything() }));
});

test("budgets that don't load offer Try again, never a guess to change", async ({ page }) => {
  let failing = true;
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/spending")) {
      return failing ? route.fulfill({ status: 500 }) : route.fulfill({ json: spending });
    }
    if (path.endsWith("/model/test")) {
      return route.fulfill({ json: { ok: true, latencyMs: 300, tools: false, reply: "ready" } });
    }
    const settings = { displayName: "Sam", about: "", onboarded: false, model: null };
    const starter = { kind: "workers-ai", model: "@cf/meta/llama", key: null };
    if (path.endsWith("/model")) return route.fulfill({ json: { ...settings, model: starter } });
    return route.fulfill(path.endsWith("/settings") ? { json: settings } : { status: 204 });
  });

  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Try without a key", { exact: true }).click();
  await page.getByRole("button", { name: "Save and test" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("I couldn't load your budgets.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Change/ })).toHaveCount(0);
  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Task budget: $0.50 per task")).toBeVisible();
  await expect(page.getByRole("button", { name: "Change task budget" })).toBeVisible();
});

test("a resumed setup keeps the saved provider, so Save reuses the saved key", async ({ page }) => {
  const saved = {
    kind: "openai-chat",
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "router/model",
  };
  const bodies: unknown[] = [];
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") bodies.push(route.request().postDataJSON());
    const settings = { displayName: "Sam", about: "", onboarded: false };
    const model = { ...saved, key: { last4: "WXYZ" } };
    if (path.endsWith("/profile")) return route.fulfill({ status: 204 });
    return route.fulfill({ json: { ...settings, model } });
  });

  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveValue("router/model");
  await page.getByRole("button", { name: "Save and test" }).click();
  expect(bodies).toContainEqual(saved);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`the Anthropic preset, ${colorScheme}, ${width} px: saves its URL and model, axe clean`, async ({
      page,
    }) => {
      const bodies: unknown[] = [];
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
      await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
      await page.route("/api/settings**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() !== "GET") bodies.push(route.request().postDataJSON());
        const settings = { displayName: "Sam", about: "", onboarded: false, model: null };
        if (path.endsWith("/profile")) return route.fulfill({ status: 204 });
        if (path.endsWith("/model")) {
          const body = route.request().postDataJSON();
          const model = { ...body, apiKey: undefined, key: { last4: "WXYZ" } };
          return route.fulfill({ json: { ...settings, model } });
        }
        return route.fulfill({ json: settings });
      });

      await page.goto("/onboarding");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByText("Anthropic", { exact: true }).click();
      await expect(page.getByLabel("Model", { exact: true })).toHaveAttribute(
        "placeholder",
        "claude-sonnet-5-5",
      );
      expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.getByLabel("API key", { exact: true }).fill(KEY);
      await page.getByRole("button", { name: "Save and test" }).click();
      await expect.poll(() => bodies.length).toBeGreaterThan(1);
      expect(bodies).toContainEqual({
        kind: "openai-chat",
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-5-5",
        apiKey: KEY,
      });
    });
  }
}
