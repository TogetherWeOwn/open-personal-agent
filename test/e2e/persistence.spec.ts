// SPDX-License-Identifier: Apache-2.0
// §17 Persistence (PRD §11 #9, conversations): claim a fresh deployment, onboard with the mock
// model, chat, then reload and restart the dev server on the same state. The restart also evicts
// the Assistant Durable Object, so the conversation has to come back from D1.
import type { HarnessEvent } from "@opa/core";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { startStack } from "./stack.mjs";

test.describe.configure({ mode: "serial" });

let stack: Awaited<ReturnType<typeof startStack>>;
let context: BrowserContext;
let page: Page;
const conversationId = crypto.randomUUID();

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

/** Sends one message over the chat socket and resolves with the turn's events. */
function chat(text: string): Promise<HarnessEvent[]> {
  return page.evaluate(
    ({ conversationId, text }) =>
      new Promise<HarnessEvent[]>((resolve, reject) => {
        const events: HarnessEvent[] = [];
        const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/chat`);
        ws.onopen = () => ws.send(JSON.stringify({ type: "chat.send", conversationId, text }));
        ws.onerror = () => reject(new Error("chat socket failed"));
        ws.onmessage = (msg) => {
          const event = JSON.parse(msg.data) as HarnessEvent;
          events.push(event);
          if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
            ws.close();
            resolve(events);
          }
        };
      }),
    { conversationId, text },
  );
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
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("ms to the first word")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Start chatting" }).click();
  await page.waitForURL("/");
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
});

test("a chat turn streams the mock model's reply and is saved", async () => {
  const events = await chat("Remember the blue door");
  expect(events.map((e) => e.type)).toContain("message.delta");
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", sessionId: conversationId });
  expect(events.find((e) => e.type === "message.completed")?.payload).toEqual({
    text: firstTurn[1]?.content,
  });
  expect(await messages()).toEqual(firstTurn);
});

test("the conversation survives a reload", async () => {
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(await messages()).toEqual(firstTurn);
});

test("the conversation and the session survive a dev-server restart", async () => {
  await stack.restart();
  await page.reload();
  // Still signed in: the chat, not the sign-in screen.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  expect(await messages()).toEqual(firstTurn);
  // The saved key still opens, and the next turn continues the same conversation.
  const events = await chat("What colour was the door?");
  expect(events.at(-1)?.type).toBe("turn.completed");
  expect(await messages()).toEqual([
    ...firstTurn,
    { role: "user", content: "What colour was the door?" },
    { role: "assistant", content: "You said: What colour was the door?" },
  ]);
});
