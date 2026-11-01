// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Low entropy: the canary allowlist in .gitleaks.toml covers only `*.test.*` files.
const KEY = "test-key-WXYZ";
const model = { kind: "openai-chat", providerId: "openai", baseUrl: "https://api.openai.com/v1" };

test("onboarding saves a key, shows only its last 4, tests it and opens the chat", async ({
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
  expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
  // A base URL and model typed under "Other" stay behind when the user switches to OpenAI.
  await page.getByText("Other OpenAI-compatible", { exact: true }).click();
  await page.getByLabel("Base URL").fill("https://other.test/v1");
  await page.getByLabel("Model", { exact: true }).fill("other/model");
  await page.getByText("OpenAI", { exact: true }).click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Back on the model step, only the last 4 show, and a blank key field keeps the saved key.
  await page.getByRole("button", { name: "Change model" }).click();
  await expect(page.getByText("Saved key ending in WXYZ.")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("412 ms to the first word")).toBeVisible();
  await expect(page.getByText("Supported")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Start chatting" }).click();
  await page.waitForURL("/");

  expect(bodies).toContainEqual({ displayName: "Sam", about: "" });
  expect(bodies).toContainEqual({
    ...model,
    kind: "openai-chat",
    model: "gpt-4.1-mini",
    apiKey: KEY,
  });
  expect(bodies).toContainEqual({ ...model, model: "gpt-4.1-mini" });
  expect(JSON.stringify(bodies)).not.toContain("other");
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
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("button", { name: "Test" })).toBeVisible();
  expect(bodies).toContainEqual(saved);
});
