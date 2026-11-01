// SPDX-License-Identifier: Apache-2.0
// The first run a new user makes (PRD A-O1): claim with a passkey, onboard, get a first answer,
// all through the UI. `verify:cloudflare` runs it on a fresh deployment with OPA_SETUP_TOKEN set
// and the starter model on Workers AI. Without it, it runs on a local stack with the mock model.
import { expect, type Page, test } from "@playwright/test";
import { startStack } from "../e2e/stack.mjs";

const remote = process.env.BASE_URL && process.env.OPA_SETUP_TOKEN;
let stack: Awaited<ReturnType<typeof startStack>> | undefined;

test.beforeAll(async () => {
  if (!remote) stack = await startStack({ port: 8792 });
});

test.afterAll(async () => {
  await stack?.close();
});

async function chooseModel(page: Page) {
  if (!stack) {
    await page.getByText("Try without a key").click();
    return;
  }
  await page.getByText("Other OpenAI-compatible", { exact: true }).click();
  await page.getByLabel("Base URL").fill(stack.modelUrl);
  await page.getByLabel("Model", { exact: true }).fill("mock-echo");
  await page.getByLabel("API key", { exact: true }).fill("mock-key");
}

test("claim, onboard and get a first answer", async ({ browser }) => {
  const baseURL = stack?.url ?? process.env.BASE_URL;
  const token = stack?.setupToken ?? process.env.OPA_SETUP_TOKEN ?? "";
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  // A platform passkey that always verifies the user.
  const cdp = await context.newCDPSession(page);
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

  await page.goto(`/setup#token=${encodeURIComponent(token)}`);
  await page.getByRole("button", { name: "Create your passkey" }).click();
  await expect(page.getByRole("list", { name: "Recovery codes" })).toBeVisible();
  await page.getByText("I've saved these codes somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL("/onboarding");
  await page.getByLabel("What should your assistant call you?").fill("Sam");
  await page.getByRole("button", { name: "Continue" }).click();
  await chooseModel(page);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Test" }).click();
  // A cold Workers AI model can take a while to load.
  await expect(page.getByText("ms to the first word")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  // The chat lists conversations once its socket opens; a send before that is refused.
  const connected = page.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/conversations" && res.ok(),
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Start chatting" }).click();
  await page.waitForURL("/");
  await connected;

  const prompt = "Say hello in five words or fewer.";
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  const log = page.getByRole("log", { name: "Messages" });
  const reply = log
    .getByText("Assistant", { exact: true })
    .locator("xpath=following-sibling::p[1]");
  await expect(reply).toBeVisible({ timeout: 60_000 });
  // The caret marks a reply that is still streaming.
  await expect(log.locator(".caret")).toHaveCount(0, { timeout: 60_000 });
  await expect(log.getByText("This reply failed")).toHaveCount(0);
  if (stack) await expect(reply).toHaveText(`You said: ${prompt}`);
  else {
    await expect(reply).not.toBeEmpty();
    // The web build's stand-in transport; a deployment must answer from the model.
    await expect(reply).not.toContainText("This is a placeholder reply");
  }
  await context.close();
});
