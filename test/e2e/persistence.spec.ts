// SPDX-License-Identifier: Apache-2.0
// §17 Persistence (PRD §11 #9, conversations): claim a fresh deployment, onboard with the mock
// model, chat through the composer, then reload and restart the dev server on the same state. The
// restart also evicts the Assistant Durable Object, so the conversation has to come back from D1.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { startStack } from "./stack.mjs";

test.describe.configure({ mode: "serial" });

let stack: Awaited<ReturnType<typeof startStack>>;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  stack = await startStack({ port: 8791 });
  context = await browser.newContext({ baseURL: stack.url });
  page = await context.newPage();
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
});

test.afterAll(async () => {
  await context?.close();
  await stack?.close();
});

/** The chat's ID, from the server's list. The page makes it up when the chat starts. */
let conversationId = "";

/**
 * Resolves once the chat socket is open: the page lists the conversations on every connect. A send
 * before that is answered with "Not connected".
 */
function socketOpen() {
  return page.waitForResponse((res) => new URL(res.url()).pathname === "/api/conversations");
}

/** Sends one message through the composer and waits for the streamed reply in the log. */
async function chat(text: string, reply: string) {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(text);
  await composer.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByText(reply, { exact: true })).toBeVisible();
  // Stop turns back into Send once the turn ends.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await expect(composer).toHaveValue("");
}

/** Opens the saved chat from the list and checks that its messages render. */
async function openSaved(turns: { role: string; content: string }[]) {
  await page.getByRole("option", { name: "Remember the blue door" }).click();
  const log = page.getByRole("log", { name: "Messages" });
  for (const { role, content } of turns) {
    await expect(
      log.getByText(role === "user" ? `You: ${content}` : content, { exact: true }),
    ).toBeVisible();
  }
}

async function messages() {
  const res = await page.request.get(`/api/conversations/${conversationId}/messages`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { messages: { role: string; content: string }[] };
  return body.messages.map(({ role, content }) => ({ role, content }));
}

const firstTurn = [
  { role: "user", content: "Remember the blue door" },
  { role: "assistant", content: "You said: Remember the blue door" },
];

test("claim with a passkey and onboard with the mock model", async () => {
  await page.goto(`/setup#token=${encodeURIComponent(stack.setupToken)}`);
  await page.getByRole("button", { name: "Create your passkey" }).click();
  await expect(page.getByRole("list", { name: "Recovery codes" })).toBeVisible();
  await page.getByText("I've saved these codes somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.waitForURL("/onboarding");
  await page.getByLabel("What should your assistant call you?").fill("Sam");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Other OpenAI-compatible", { exact: true }).click();
  await page.getByLabel("Base URL").fill(stack.modelUrl);
  await page.getByLabel("Model", { exact: true }).fill("mock-echo");
  await page.getByLabel("API key", { exact: true }).fill("mock-key");
  await page.getByRole("button", { name: "Save and test" }).click();
  await expect(page.getByText("ms to the first word")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  // Costs and limits, then Safety, each keeping its defaults.
  await expect(page.getByRole("heading", { name: "Costs and limits" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "How I ask before acting" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  const open = socketOpen();
  await page.getByRole("button", { name: "Start chatting" }).click();
  await page.waitForURL("/");
  await open;
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("a chat turn streams the mock model's reply and is saved", async () => {
  await chat("Remember the blue door", "You said: Remember the blue door");
  await expect(page.getByRole("option", { name: "Remember the blue door" })).toBeVisible();

  const res = await page.request.get("/api/conversations");
  expect(res.status()).toBe(200);
  const { conversations } = (await res.json()) as {
    conversations: { id: string; title: string }[];
  };
  expect(conversations).toHaveLength(1);
  expect(conversations[0]?.title).toBe("Remember the blue door");
  conversationId = conversations[0]?.id ?? "";
  expect(await messages()).toEqual(firstTurn);
});

test("the conversation survives a reload", async () => {
  const open = socketOpen();
  await page.reload();
  await open;
  await openSaved(firstTurn);
  expect(await messages()).toEqual(firstTurn);
});

test("the conversation and the session survive a dev-server restart", async () => {
  await stack.restart();
  const open = socketOpen();
  await page.reload();
  await open;
  // Still signed in: the chat, not the sign-in screen, with the saved chat in the list.
  await openSaved(firstTurn);
  expect(await messages()).toEqual(firstTurn);
  // The saved key still opens, and the next turn continues the same conversation.
  await chat("What colour was the door?", "You said: What colour was the door?");
  expect(await messages()).toEqual([
    ...firstTurn,
    { role: "user", content: "What colour was the door?" },
    { role: "assistant", content: "You said: What colour was the door?" },
  ]);
});
