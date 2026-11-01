// SPDX-License-Identifier: Apache-2.0
// The vault reset flow (TWO-650): saved keys that no longer open are reset after a passkey
// step-up, then entered again. The chat runs on the mock transport; the API is stubbed here.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

// Low entropy: the canary allowlist in .gitleaks.toml covers only `*.test.*` files.
const KEY = "test-key-WXYZ";
const ADDED = Date.UTC(2026, 9, 20);
const b64 = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const creation = {
  rp: { name: "Open Personal Agent", id: "localhost" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  attestation: "none",
};
const stepUpOptions = {
  challenge: b64("step-up-challenge"),
  rpId: "localhost",
  userVerification: "required",
};

/** A platform authenticator holding one passkey for this site, as the claim left it, or none. */
async function passkey(page: Page, registered = true) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (registered) await register(page);
}

/** Creates the passkey on the device, as the claim would have. */
async function register(page: Page) {
  await page.evaluate(async (opts) => {
    const bytes = (s: string) => new TextEncoder().encode(s);
    await navigator.credentials.create({
      publicKey: {
        ...opts,
        challenge: bytes("c"),
        user: { id: bytes("owner-id"), name: "owner", displayName: "owner" },
      } as PublicKeyCredentialCreationOptions,
    });
  }, creation);
}

interface Stub {
  vault: "ok" | "empty" | "reset_required";
  /** What `PUT /api/settings/providers/p1` answers next; then it saves. */
  saveAnswers: { status: number; json: unknown }[];
  /** What `POST /api/settings/vault/reset` answers next; then 204. */
  resetAnswers: { status: number; json: unknown }[];
  calls: { method: string; path: string; body: unknown }[];
}

/** A stateful stand-in for the settings, vault and step-up routes. */
async function stub(page: Page, vault: Stub["vault"] = "reset_required"): Promise<Stub> {
  const s: Stub = { vault, saveAnswers: [], resetAnswers: [], calls: [] };
  const provider = () => ({
    id: "p1",
    kind: "openai-chat",
    api: "openai-responses",
    providerId: "openai",
    baseUrl: "https://api.openai.com/v1",
    providerName: "OpenAI",
    model: "gpt-4.1-mini",
    modelName: "GPT-4.1 mini",
    createdAt: ADDED,
    // The reset deletes the key; the provider stays, waiting for a new one.
    key:
      s.vault === "empty"
        ? null
        : { last4: "WXYZ", createdAt: ADDED, updatedAt: ADDED, lastUsedAt: null },
    price: null,
  });
  const view = () => ({
    displayName: "Sam",
    about: "",
    onboarded: true,
    model: null,
    providers: [provider()],
    roles: {
      chat: { provider: "p1", model: "gpt-4.1-mini" },
      background: { provider: "p1", model: "gpt-4.1-mini", default: true },
      embedding: null,
    },
  });
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route(/\/api\/(settings|auth\/step-up)/, async (route) => {
    const { pathname: path } = new URL(route.request().url());
    const method = route.request().method();
    const body = method === "GET" ? undefined : route.request().postDataJSON();
    s.calls.push({ method, path, body });
    if (path === "/api/settings/vault") return route.fulfill({ json: { state: s.vault } });
    if (path === "/api/auth/step-up/options") {
      return route.fulfill({ json: { options: stepUpOptions } });
    }
    if (path === "/api/settings/vault/reset") {
      const answer = s.resetAnswers.shift();
      if (answer) return route.fulfill(answer);
      s.vault = "empty";
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/settings/providers/p1" && method === "PUT") {
      const answer = s.saveAnswers.shift();
      if (answer) return route.fulfill(answer);
      s.vault = "ok";
      return route.fulfill({ json: provider() });
    }
    return route.fulfill({ json: view() });
  });
  return s;
}

const panel = (page: Page) => page.getByTestId("vault-reset");
const resetButton = (page: Page) =>
  page.getByRole("button", { name: "Delete saved keys and reset" });
const posts = (s: Stub, path: string) =>
  s.calls.filter((c) => c.method === "POST" && c.path === path);

test("409 vault_reset_required on save → passkey reset → the key is entered again", async ({
  page,
}) => {
  const s = await stub(page, "ok");
  await page.goto("/settings/models");
  await passkey(page);
  await expect(page.getByText("Key ending in WXYZ")).toBeVisible();
  await expect(panel(page)).toHaveCount(0);

  // Saving finds the saved keys don't open any more: the reset panel takes over.
  s.saveAnswers.push({ status: 409, json: { error: "vault_reset_required" } });
  s.vault = "reset_required";
  await page.getByRole("button", { name: "Edit GPT-4.1 mini · OpenAI" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Reset them, then enter your key again.");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText("Resetting deletes all of your saved keys and secrets.");

  // The first step-up's challenge has expired: one fresh passkey ceremony, without asking.
  s.resetAnswers.push({ status: 401, json: { error: "step_up_required" } });
  await resetButton(page).click();
  await expect(page.getByRole("status")).toContainText("Your saved keys were deleted.");
  await expect(panel(page)).toHaveCount(0);
  const resets = posts(s, "/api/settings/vault/reset");
  expect(posts(s, "/api/auth/step-up/options").map((c) => c.body)).toEqual([
    { action: "vault.reset" },
    { action: "vault.reset" },
  ]);
  expect(resets).toHaveLength(2);
  for (const { body } of resets) {
    expect(body).toMatchObject({ confirm: "reset", credential: { id: expect.any(String) } });
  }

  // Back at the key entry form: the provider's form is open, with no saved key to keep.
  await expect(page.getByText("No key saved. Enter its API key again to use it.")).toBeVisible();
  await expect(page.getByText(/Leave blank to keep it/)).toHaveCount(0);
  const card = page.getByRole("listitem").filter({ hasText: "GPT-4.1 mini · OpenAI" });
  await card.getByLabel("API key", { exact: true }).fill(KEY);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Key ending in WXYZ")).toBeVisible();
  expect(s.calls.filter((c) => c.method === "PUT").at(-1)).toMatchObject({
    path: "/api/settings/providers/p1",
    body: { apiKey: KEY },
  });
  expect(await page.content()).not.toContain(KEY);
});

test("a chat refused for unopenable keys links to the reset panel", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await passkey(page);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("/mock vault reset");
  await box.press("Enter");
  await expect(page.getByRole("log").getByText("Your saved keys can't be opened.")).toBeVisible();
  await page.getByRole("link", { name: "Reset them in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/models$/);
  await expect(panel(page)).toBeVisible();
  await resetButton(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("No key saved. Enter its API key again to use it.")).toBeVisible();
  expect(posts(s, "/api/settings/vault/reset")).toHaveLength(1);
  // The keyless form keeps a way out besides a new key: Remove, with the chat-model guard.
  await page.getByRole("button", { name: "Remove GPT-4.1 mini · OpenAI" }).click();
  await expect(page.getByRole("alert")).toContainText("This provider is your chat model.");
});

test("reset_not_required refreshes the state; vault_unavailable and a cancelled passkey delete nothing", async ({
  page,
}) => {
  const s = await stub(page);
  await page.goto("/settings/models");
  await expect(panel(page)).toBeVisible();

  // No passkey for this site on the device: the browser's prompt fails, and nothing is sent.
  await passkey(page, false);
  await resetButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("nothing was deleted");
  expect(posts(s, "/api/settings/vault/reset")).toHaveLength(0);

  await register(page);
  s.resetAnswers.push({ status: 503, json: { error: "vault_unavailable" } });
  await resetButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText(
    "The server's master key isn't available right now, so nothing was deleted.",
  );

  // Another tab fixed it meanwhile: the panel checks again and goes away.
  s.resetAnswers.push({ status: 409, json: { error: "reset_not_required" } });
  s.vault = "ok";
  await resetButton(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Your saved keys open again.");
  await expect(page.getByText("Key ending in WXYZ")).toBeVisible();
});

test("onboarding offers the reset when saving the model finds unopenable keys", async ({
  page,
}) => {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  let reset = false;
  const saved = { last4: "WXYZ", createdAt: ADDED, updatedAt: ADDED, lastUsedAt: null };
  const model = () => ({
    kind: "openai-chat",
    providerId: "openai",
    baseUrl: null,
    model: "gpt-4.1-mini",
    key: reset ? null : saved,
  });
  const view = () => ({ displayName: "Sam", about: "", onboarded: false, model: model() });
  const puts: unknown[] = [];
  await page.route(/\/api\/(settings|auth\/step-up)/, async (route) => {
    const { pathname: path } = new URL(route.request().url());
    if (path === "/api/auth/step-up/options") {
      return route.fulfill({ json: { options: stepUpOptions } });
    }
    if (path === "/api/settings/vault/reset") {
      reset = true;
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/settings/model") {
      puts.push(route.request().postDataJSON());
      return reset
        ? route.fulfill({ json: view() })
        : route.fulfill({ status: 409, json: { error: "vault_reset_required" } });
    }
    return route.fulfill({ json: view() });
  });
  await page.goto("/onboarding");
  await passkey(page);
  await page.getByLabel("What should your assistant call you?").fill("Sam");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Saved key ending in WXYZ. Leave blank to keep it.")).toBeVisible();
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(panel(page)).toBeVisible();

  await resetButton(page).click();
  await expect(page.getByRole("status")).toContainText("Enter your API key again.");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText(/Leave blank to keep it/)).toHaveCount(0);
  await page.getByLabel("API key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Test", level: 2 })).toBeVisible();
  expect(puts.at(-1)).toMatchObject({ apiKey: KEY });
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 1280]) {
    test(`vault reset panel, ${colorScheme}, ${width} px: axe clean, baseline`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: 800 });
      await stub(page);
      await page.goto("/settings/models");
      await expect(panel(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
      await expect(panel(page)).toHaveScreenshot(`vault-reset-${colorScheme}-${width}.png`);
    });
  }
}
