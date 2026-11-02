// SPDX-License-Identifier: Apache-2.0
// The keyboard-only walkthrough (M3-24 AC3): chat, approval and memory edit completed with the
// keyboard alone. Nothing in this file may call `click`, `focus`, `fill` or any mouse API —
// every step Tabs to its target and activates it with Enter or Space, as a keyboard user would.
// (Allow deliberately ignores Enter, M3-07 AC7, so buttons here are pressed with Space.)
import { expect, type Locator, type Page, test } from "@playwright/test";

const HOUR = 3_600_000;

/** Tabs forward until `target` holds focus; Tab wraps, so this also recovers from overshoot. */
async function tabTo(page: Page, target: Locator, max = 80) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

/** Presses the focused button with Space (Enter is a no-op on Allow by design). */
async function press(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Space");
}

async function stubShell(page: Page) {
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (r) =>
    r.fulfill({
      json: { onboarded: true, providers: [], roles: { chat: null, background: null } },
    }),
  );
  await page.route(/\/api\/attachments\/config/, (r) =>
    r.fulfill({ json: { maxBytes: 1024, accept: ".txt", types: [], model: null } }),
  );
}

test("keyboard only: send a chat message and read the reply", async ({ page }) => {
  await stubShell(page);
  // A configured chat model, as in chat.spec.ts, so the composer is ready to send.
  await page.route("/api/settings", (r) =>
    r.fulfill({
      json: {
        displayName: "Sam",
        about: "",
        onboarded: true,
        model: null,
        providers: [
          {
            id: "p1",
            kind: "openai-chat",
            api: "openai-responses",
            providerId: "openai",
            baseUrl: "https://api.openai.com/v1",
            providerName: "OpenAI",
            model: "gpt-4.1-mini",
            modelName: "GPT-4.1 mini",
            createdAt: Date.UTC(2026, 9, 20),
            key: {
              last4: "WXYZ",
              createdAt: Date.UTC(2026, 9, 20),
              updatedAt: Date.UTC(2026, 9, 20),
              lastUsedAt: null,
            },
            price: {
              inputUsdPerMTok: 0.4,
              outputUsdPerMTok: 1.6,
              verifiedAt: "2026-11-01",
              stale: false,
            },
          },
        ],
        roles: {
          chat: { provider: "p1", model: "gpt-4.1-mini" },
          background: null,
          embedding: null,
        },
      },
    }),
  );
  await page.goto("/");
  const box = page.getByRole("textbox", { name: "Message" });
  await tabTo(page, box);
  await page.keyboard.type("Plan my week");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("a word at a time.");
  await expect(page.getByRole("status")).toContainText("Assistant replied: ");
  await expect(box).toHaveValue("");
});

const batch = (n: number) => ({
  batchId: `batch_${n}`,
  conversationId: `c${n}`,
  conversationTitle: `Chat ${n}`,
  taskId: null,
  createdAt: Date.now() - n * 1000,
  expiresAt: Date.now() + (n + 1) * HOUR,
  items: [
    {
      approvalId: `appr_${n}`,
      tool: "send_email",
      args: JSON.stringify({ to: [`friend${n}@example.com`], body: "Hello" }),
      target: "example.com",
      risk: "consequential",
      rule: "default_consequential",
      scopes: ["once", "hour"],
      expiresAt: Date.now() + (n + 1) * HOUR,
    },
  ],
});

test("keyboard only: allow one approval and refuse another in the Inbox", async ({ page }) => {
  await stubShell(page);
  let batches: Record<string, unknown>[] = [batch(1), batch(2)];
  const posts: { id: string; body: Record<string, unknown> }[] = [];
  await page.route("/api/approvals?status=pending", (r) => r.fulfill({ json: { batches } }));
  await page.route(/\/api\/approvals\?status=decided&since=\d+$/, (r) =>
    r.fulfill({ json: { batches: [] } }),
  );
  await page.route(/\/api\/approvals\/[^/?]+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop() ?? "";
    posts.push({ id, body: r.request().postDataJSON() as Record<string, unknown> });
    batches = batches.filter((b) => b.batchId !== id);
    return r.fulfill({ json: { status: "resumed" } });
  });

  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Needs your OK (2)" })).toBeVisible();
  const cards = page
    .getByRole("region", { name: /^Needs your OK/ })
    .getByRole("region", { name: /^Send email · Needs your OK in Chat/ });

  // Allow is never the default focus, and reaching it takes real Tabs.
  await press(page, cards.first().getByRole("button", { name: "Allow", exact: true }));
  await expect(page.getByRole("heading", { name: "Needs your OK (1)" })).toBeVisible();

  await press(page, cards.first().getByRole("button", { name: "Don't allow" }));
  await expect(page.getByRole("heading", { name: "Nothing needs you right now." })).toBeVisible();

  expect(posts).toEqual([
    {
      id: "batch_1",
      body: { decisions: [{ approvalId: "appr_1", decision: "approve", scope: "once" }] },
    },
    {
      id: "batch_2",
      body: { decisions: [{ approvalId: "appr_2", decision: "deny", scope: "once" }] },
    },
  ]);
});

test("keyboard only: edit a memory note and save the new version", async ({ page }) => {
  await stubShell(page);
  await page.route("/api/settings/memory", (r) => r.fulfill({ json: { learnFromChats: true } }));
  const note = (over: Record<string, unknown>) => ({
    id: "n1",
    kind: "fact",
    text: "Sam lives in Leeds",
    trust: "user",
    op: "create",
    source: "chat",
    sourceRef: null,
    sourceExcerpt: null,
    conversation: { id: "c1", title: "Moving house" },
    createdAt: Date.now() - 30 * 86_400_000,
    lastUsedAt: null,
    expiresAt: null,
    ...over,
  });
  let notes = [note({})];
  await page.route("/api/memory**", (route) => {
    if (route.request().method() === "PUT") {
      const { text } = route.request().postDataJSON() as { text: string };
      const next = note({
        id: "n1-v2",
        text,
        op: "update",
        source: "memory_screen",
        conversation: null,
      });
      notes = [next];
      return route.fulfill({ json: { memory: next } });
    }
    return route.fulfill({ json: { memories: notes } });
  });

  await page.goto("/memory");
  await press(page, page.getByRole("button", { name: "Edit: Sam lives in Leeds" }));
  const editor = page.getByLabel("Edit note");
  await tabTo(page, editor);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Sam lives in Paris");
  await press(page, page.getByRole("button", { name: "Save" }));
  await expect(page.getByText("Sam lives in Paris")).toBeVisible();
  // Focus lands back on the note's Edit button, so the next Tab continues where the user was.
  await expect(page.getByRole("button", { name: "Edit: Sam lives in Paris" })).toBeFocused();
});
