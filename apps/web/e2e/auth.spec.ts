// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";

// Low entropy: the canary allowlist in .gitleaks.toml covers only `*.test.*` files.
const TOKEN = "setup-token-for-e2e";
const CODES = Array.from({ length: 10 }, (_, i) => `abcde-fghij-klmno-pqrst-uvwx${i}`);
const b64 = (s: string) => btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const creation = {
  challenge: b64("register-challenge"),
  rp: { name: "Open Personal Agent", id: "localhost" },
  user: { id: b64("owner-id"), name: "owner", displayName: "owner" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  attestation: "none",
};

// `vite preview` proxies `/setup` to the Worker, which serves the app there while it is open.
test.beforeEach(async ({ page }) => {
  await page.route(/\/setup$/, async (route) =>
    route.fulfill({
      response: await route.fetch({ url: new URL("/", route.request().url()).href }),
    }),
  );
});

/** A platform passkey that always passes user verification until told otherwise. */
async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return (verified: boolean) =>
    cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: verified });
}

/** Mocks `/setup/options` and `/setup`; `answers` are the `/setup` replies, in order. */
async function mockSetup(page: Page, answers: { status: number; json: unknown }[], mode = "claim") {
  const bodies: Record<string, unknown>[] = [];
  await page.route("/setup/options", (route) => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ json: { mode, options: creation } });
  });
  await page.route(/\/setup$/, (route: Route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON());
    return route.fulfill(answers.shift() ?? { status: 200, json: { mode, recoveryCodes: CODES } });
  });
  return bodies;
}

async function signedOut(page: Page, error = "unauthenticated") {
  await page.route("/api/me", (route) =>
    route.fulfill({ status: error === "not_claimed" ? 403 : 401, json: { error } }),
  );
}

async function checkScreen(page: Page, name: string) {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
      await expect(page).toHaveScreenshot(`${name}-${colorScheme}-${width}.png`);
    }
  }
}

test("the setup link claims, shows the codes once and opens onboarding", async ({ page }) => {
  await authenticator(page);
  const bodies = await mockSetup(page, []);
  await page.goto(`/setup#token=${TOKEN}`);

  // The token leaves the address bar and the history entry at once.
  expect(page.url()).not.toContain(TOKEN);
  expect(await page.evaluate(() => window.location.href)).toMatch(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Claim your assistant" })).toBeFocused();
  await expect(page.getByLabel("Setup token")).toHaveCount(0);
  await checkScreen(page, "claim");

  await page.getByRole("button", { name: "Create your passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeFocused();
  await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveText(
    CODES,
  );
  await expect(page.getByText("They won't be shown again.")).toBeVisible();
  expect(bodies[0]).toEqual({ token: TOKEN });
  expect(bodies[1]).toMatchObject({ token: TOKEN, credential: { type: "public-key" } });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .txt" }).click();
  expect((await download).suggestedFilename()).toBe("recovery-codes.txt");
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByText("I've saved these codes somewhere safe").click();
  await checkScreen(page, "recovery-codes");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("/onboarding");
});

test("without a fragment the token is typed; a wrong one says so", async ({ page }) => {
  await authenticator(page);
  await page.route("/setup/options", (route) =>
    route.fulfill({ status: 403, json: { error: "invalid_token" } }),
  );
  await page.goto("/setup");
  const field = page.getByLabel("Setup token");
  await expect(field).toHaveAttribute("type", "password");
  await expect(field).toHaveAttribute("autocomplete", "off");
  await expect(page.getByRole("button", { name: "Create your passkey" })).toBeDisabled();
  await field.fill("wrong");
  await page.getByRole("button", { name: "Create your passkey" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That setup token doesn't match. Check you copied all of it.",
  );
});

test("a refused passkey offers Try again; recovery mode renames the screen", async ({ page }) => {
  const setVerified = await authenticator(page);
  await setVerified(false);
  await mockSetup(page, [], "recovery");
  await page.goto(`/setup#token=${TOKEN}`);
  await page.getByRole("button", { name: "Create your passkey" }).click();
  await expect(page.getByRole("alert")).toHaveText("No passkey was created.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Recover your account");
  await setVerified(true);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
});

test("an expired challenge is retried once without asking", async ({ page }) => {
  await authenticator(page);
  const bodies = await mockSetup(page, [{ status: 400, json: { error: "no_challenge" } }]);
  await page.goto(`/setup#token=${TOKEN}`);
  await page.getByRole("button", { name: "Create your passkey" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  expect(bodies).toHaveLength(4);
});

for (const [error, text, link] of [
  ["setup_conflict", "Setup was finished in another tab or browser.", "Sign in"],
  ["already_claimed", "This assistant already has an owner.", "Sign in"],
  ["setup_token_weak", "The server needs a change before it can be claimed.", "See what to change"],
  ["no_challenge", "Something went wrong and no passkey was saved. Try again.", null],
] as const) {
  test(`${error} is explained, with a way on`, async ({ page }) => {
    await authenticator(page);
    const reply = { status: 409, json: { error } };
    await mockSetup(page, [reply, reply]);
    await page.goto(`/setup#token=${TOKEN}`);
    await page.getByRole("button", { name: "Create your passkey" }).click();
    await expect(page.getByRole("alert")).toContainText(text);
    if (link) await expect(page.getByRole("alert").getByRole("link", { name: link })).toBeVisible();
  });
}

test("a signed-out visitor to / gets Sign in, never the chat", async ({ page }) => {
  await signedOut(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await checkScreen(page, "sign-in");
});

test("an unclaimed deployment sends / to the claim", async ({ page }) => {
  await signedOut(page, "not_claimed");
  await page.goto("/");
  await page.waitForURL("/setup");
  await expect(page.getByRole("heading", { name: "Claim your assistant" })).toBeVisible();
});

test("a signed-in user who hasn't onboarded lands on onboarding", async ({ page }) => {
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) =>
    route.fulfill({ json: { displayName: "", about: "", onboarded: false, model: null } }),
  );
  await page.goto("/");
  await page.waitForURL("/onboarding");
  await expect(page.getByRole("heading", { name: "Set up your assistant" })).toBeVisible();
});

test("Sign in with your passkey signs in and opens the app", async ({ page }) => {
  await authenticator(page);
  await signedOut(page);
  const posts: string[] = [];
  await page.route("/api/auth/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    posts.push(path);
    if (path.endsWith("/options")) {
      const options = { challenge: b64("login-challenge"), rpId: "localhost" };
      return route.fulfill({ json: { options: { ...options, userVerification: "required" } } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  // A passkey for this site, as the claim would have left on the device.
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
  await page.getByRole("button", { name: "Sign in with your passkey" }).click();
  await expect.poll(() => posts).toEqual(["/api/auth/login/options", "/api/auth/login"]);
});
