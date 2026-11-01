// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

// Low entropy: the canary allowlist in .gitleaks.toml covers only `*.test.*` files.
const KEY = "test-key-WXYZ";
const ADDED = Date.UTC(2026, 9, 20);
const USED = Date.UTC(2026, 9, 31);

const provider = (over: Record<string, unknown>) => ({
  id: "p1",
  kind: "openai-chat",
  api: "openai-responses",
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1",
  providerName: "OpenAI",
  model: "gpt-4.1-mini",
  modelName: "GPT-4.1 mini",
  createdAt: ADDED,
  key: { last4: "WXYZ", createdAt: ADDED, updatedAt: ADDED, lastUsedAt: USED },
  price: { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6, verifiedAt: "2026-11-01", stale: false },
  ...over,
});
const router = provider({
  id: "p2",
  providerId: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  providerName: "OpenRouter",
  model: "some/model",
  modelName: "some/model",
  key: { last4: "QRST", createdAt: ADDED, updatedAt: ADDED, lastUsedAt: null },
  price: null,
});

interface Stub {
  providers: Record<string, unknown>[];
  roles: { chat: unknown; background: unknown; embedding: null };
  bodies: { method: string; path: string; body: unknown }[];
}

/** A stateful stand-in for the settings routes, so the page's writes show up in its reads. */
async function stubSettings(page: Page): Promise<Stub> {
  const stub: Stub = {
    providers: [provider({}), router],
    roles: {
      chat: { provider: "p1", model: "gpt-4.1-mini" },
      background: { provider: "p1", model: "gpt-4.1-mini", default: true },
      embedding: null,
    },
    bodies: [],
  };
  const view = () => ({
    displayName: "Sam",
    about: "",
    onboarded: true,
    model: null,
    providers: stub.providers,
    roles: stub.roles,
  });
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings**", async (route) => {
    const { pathname: path } = new URL(route.request().url());
    const method = route.request().method();
    const body = method === "GET" ? undefined : route.request().postDataJSON();
    if (method !== "GET") stub.bodies.push({ method, path, body });
    if (method === "GET") return route.fulfill({ json: view() });
    if (path.endsWith("/test")) {
      return route.fulfill({
        json: {
          ok: true,
          latencyMs: 412,
          tools: true,
          toolProbe: "called",
          price: provider({}).price,
          reply: "ready",
        },
      });
    }
    if (path.endsWith("/roles")) {
      const roles = body as { chat?: unknown; background?: unknown };
      if ("chat" in roles) stub.roles.chat = roles.chat;
      if ("background" in roles) {
        stub.roles.background = roles.background
          ? { ...(roles.background as object), default: false }
          : { provider: "p1", model: "gpt-4.1-mini", default: true };
      }
      return route.fulfill({ json: view() });
    }
    if (method === "DELETE") {
      const id = path.split("/").at(-1);
      stub.providers = stub.providers.filter((p) => p.id !== id);
      return route.fulfill({ status: 204 });
    }
    if (method === "POST") {
      const { providerId, model } = body as { providerId: string; model: string };
      const added = provider({
        id: `p${stub.providers.length + 1}`,
        providerId,
        model,
        modelName: model,
        ...(providerId === "anthropic" && {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          providerName: "Anthropic",
          modelName: "Claude Sonnet 5.5",
          price: {
            inputUsdPerMTok: 2,
            outputUsdPerMTok: 10,
            verifiedAt: "2026-11-01",
            stale: false,
          },
        }),
      });
      stub.providers.push(added);
      return route.fulfill({ status: 201, json: added });
    }
    return route.fulfill({ json: view() });
  });
  return stub;
}

async function open(page: Page) {
  const stub = await stubSettings(page);
  await page.goto("/settings/models");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByRole("heading", { name: "Models", level: 2 })).toBeVisible();
  return stub;
}

test("lists each provider with its key's last 4 and dates, and never the key (M3-06 AC1)", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole("list").getByText("GPT-4.1 mini · OpenAI")).toBeVisible();
  await expect(
    page.getByText("Key ending in WXYZ · added Oct 20, 2026 · last used Oct 31, 2026"),
  ).toBeVisible();
  await expect(
    page.getByText("Key ending in QRST · added Oct 20, 2026 · never used yet"),
  ).toBeVisible();
  await expect(page.getByText(/about \$0\.09 per 100 messages/)).toBeVisible();
  // Every model choice carries its price hint (M3-16 AC5); the button shows the name alone.
  await page.getByRole("button", { name: /Chat model/ }).click();
  await expect(page.getByRole("option", { name: /GPT-4.1 mini/ })).toContainText(
    "about $0.09 per 100 messages",
  );
  await expect(page.getByRole("option", { name: /some\/model/ })).toContainText("No price on file");
  await page.keyboard.press("Escape");
  await expect(page.getByText("Chat model · Background model").first()).toBeVisible();
  expect(await page.content()).not.toContain(KEY);
});

test("changes the Background role, and back to automatic (M3-06 AC2)", async ({ page }) => {
  const stub = await open(page);
  const background = page.getByLabel("Background model");
  await expect(background).toContainText("Cheapest saved model (automatic)");
  await expect(
    page.getByText("Right now it uses GPT-4.1 mini · OpenAI (your cheapest)."),
  ).toBeVisible();
  await background.click();
  await page.getByRole("option", { name: /some\/model · OpenRouter/ }).click();
  await expect(page.getByRole("status")).toContainText("Background model saved.");
  expect(stub.bodies.at(-1)).toMatchObject({
    method: "PUT",
    path: "/api/settings/roles",
    body: { background: { provider: "p2" } },
  });
});

test("adds a provider with the shared form, tests it, and keeps the chat provider safe", async ({
  page,
}) => {
  const stub = await open(page);
  const add = page.locator("section").filter({ hasText: "Add a provider" }).last();
  await add.getByLabel("Model", { exact: true }).fill("gpt-4.1");
  await add.getByLabel("API key", { exact: true }).fill(KEY);
  await add.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByRole("status")).toContainText("Provider added.");
  expect(stub.bodies.at(-1)).toMatchObject({
    method: "POST",
    path: "/api/settings/providers",
    body: { providerId: "openai", model: "gpt-4.1", apiKey: KEY },
  });
  expect(await page.content()).not.toContain(KEY);

  await page.getByRole("button", { name: "Test GPT-4.1 mini · OpenAI" }).click();
  await expect(page.getByText("412 ms to the first word")).toBeVisible();
  await expect(page.getByText("Supported")).toBeVisible();

  // The chat model can't be removed until another takes its place; the other one can.
  await page.getByRole("button", { name: "Remove GPT-4.1 mini · OpenAI" }).first().click();
  await expect(page.getByRole("alert")).toContainText("This provider is your chat model.");
  expect(stub.bodies.filter((b) => b.method === "DELETE")).toEqual([]);
  await page.getByRole("button", { name: "Remove some/model · OpenRouter" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("list").getByText("some/model · OpenRouter")).toHaveCount(0);
});

test("adds an Anthropic key with the same form, and lists it like the others (M3-05 AC3)", async ({
  page,
}) => {
  const stub = await open(page);
  const add = page.locator("section").filter({ hasText: "Add a provider" }).last();
  await add.getByText("Anthropic", { exact: true }).click();
  await expect(add.getByLabel("Model", { exact: true })).toHaveAttribute(
    "placeholder",
    "claude-sonnet-5-5",
  );
  await add.getByLabel("API key", { exact: true }).fill(KEY);
  await add.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByRole("status")).toContainText("Provider added.");
  expect(stub.bodies.at(-1)).toMatchObject({
    method: "POST",
    path: "/api/settings/providers",
    body: {
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-5-5",
      apiKey: KEY,
    },
  });
  await expect(page.getByRole("list").getByText("Claude Sonnet 5.5 · Anthropic")).toBeVisible();
  expect(await page.content()).not.toContain(KEY);
});

test("the Agent engine page names the one engine, read-only (M3-06 AC6)", async ({ page }) => {
  await open(page);
  await page.getByRole("link", { name: "Agent engine" }).click();
  await expect(page).toHaveURL(/\/settings\/agent-engine$/);
  await expect(page.getByText("Built-in engine")).toBeVisible();
  await expect(page.getByText("Asks before risky actions")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1280]) {
    test(`models, ${colorScheme}, ${width} px: axe clean, no sideways scroll, baseline`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await open(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
      await expect(page).toHaveScreenshot(`settings-models-${colorScheme}-${width}.png`, {
        fullPage: true,
      });
    });
  }
}
