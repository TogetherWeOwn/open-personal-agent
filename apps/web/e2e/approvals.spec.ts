// SPDX-License-Identifier: Apache-2.0
// The approval card and the multi-action card in the chat (M3-07 AC6, AC7, AC11; m3-ux §3.3).
// The list comes from `GET /api/approvals` and decisions go to `POST /api/approvals/:batchId`,
// both stubbed here; the socket only tells the tab to read the list again.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Request, test } from "@playwright/test";

const HOUR = 3_600_000;

type Item = Record<string, unknown>;

const email = (over: Item = {}): Item => ({
  approvalId: "appr_1",
  tool: "send_email",
  args: JSON.stringify({
    to: ["sam@example.com", "kim@example.com"],
    body: "Hi Sam,\nSee you​ soon.",
  }),
  target: "example.com",
  risk: "consequential",
  rule: "default_consequential",
  scopes: ["once", "hour", "destination"],
  expiresAt: Date.now() + 23.5 * HOUR,
  ...over,
});

interface Stub {
  batches: Record<string, unknown>[];
  posts: { url: string; body: Record<string, unknown> }[];
  /** What the next decision POST answers. */
  reply: { status: number; json: unknown };
}

async function stub(page: Page): Promise<Stub> {
  const s: Stub = { batches: [], posts: [], reply: { status: 200, json: { status: "resumed" } } };
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (r) =>
    r.fulfill({ json: { onboarded: true, providers: [], roles: { chat: null } } }),
  );
  // The server leaves out what has expired.
  await page.route("/api/approvals?status=pending", (r) =>
    r.fulfill({ json: { batches: s.batches.filter((b) => (b.expiresAt as number) > Date.now()) } }),
  );
  await page.route(
    /\/api\/approvals\/[^/?]+(\/options)?$/,
    (r: { request(): Request; fulfill(o: object): Promise<void> }) => {
      const req = r.request();
      const body = req.postDataJSON() as Record<string, unknown>;
      s.posts.push({ url: new URL(req.url()).pathname, body });
      if (req.url().endsWith("/options")) {
        // No passkey on this browser: the prompt fails fast, as a dismissed one does.
        return r.fulfill({
          json: {
            options: {
              challenge: "AAAA",
              rpId: "localhost",
              allowCredentials: [],
              timeout: 500,
              userVerification: "required",
            },
          },
        });
      }
      // A decided batch leaves the list, as it leaves D1's pending rows.
      if (s.reply.status === 200) s.batches = [];
      return r.fulfill(s.reply);
    },
  );
  return s;
}

/** The open chat's ID, from its "Files in this chat" link. */
async function chatId(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Chat options" }).click();
  const href = await page
    .getByRole("menuitem", { name: "Files in this chat" })
    .getAttribute("href");
  await page.keyboard.press("Escape");
  return new URL(href ?? "", "http://x").searchParams.get("conversation") ?? "";
}

/** Puts `items` in the open chat as one batch and lets the tab read the list again. */
async function ask(page: Page, s: Stub, items: Item[]) {
  const conversationId = await chatId(page);
  s.batches = [
    {
      batchId: "batch_1",
      conversationId,
      conversationTitle: "Plans",
      taskId: null,
      createdAt: Date.now(),
      expiresAt: Math.min(...items.map((i) => i.expiresAt as number)),
      items,
    },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

const card = (page: Page) => page.getByRole("region", { name: /Needs your OK|need your OK/ });

test("shows the whole request, its rule and why to be careful (AC6)", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [
    email({
      rule: "floor_tainted_egress",
      taint: { kind: "web", label: "example.org" },
      scopes: ["once"],
      costMicroUsd: 140_000,
    }),
  ]);
  const c = card(page);
  await expect(c.getByRole("heading", { name: "Send email · Needs your OK" })).toBeVisible();
  await expect(c).toContainText("To: example.com");
  await expect(c).toContainText("sam@example.com");
  await expect(c).toContainText("kim@example.com");
  await expect(c).toContainText("⟨U+200B⟩"); // the hidden character, made visible
  await expect(c).toContainText(
    "Rule: This sends something out after I read outside content, so I always ask first.",
  );
  await expect(c).toContainText(
    "Why I'm careful: This includes text from a web page (example.org), which could be trying to steer me.",
  );
  await expect(c).toContainText("This will cost about $0.14 (estimate).");
  await expect(c).toContainText("Expires in 23 h");
  // Tainted egress offers "once" only.
  await expect(c).toContainText("Allow: Just this once");
  await expect(c.getByRole("radio")).toHaveCount(0);
});

test("shows hidden characters in the host and in nested fields", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [
    email({
      target: "exa\u200bmple.com",
      args: JSON.stringify({ to: { name: "Sam", address: "sam@exa\u202emple.com" } }),
    }),
  ]);
  const c = card(page);
  await expect(c).toContainText("To: exa⟨U+200B⟩mple.com");
  await expect(c.getByRole("definition").filter({ hasText: "Address" })).toContainText(
    "sam@exa⟨U+202E⟩mple.com",
  );
  await expect(c.getByText("Always for exa⟨U+200B⟩mple.com")).toBeVisible();
});

test("an empty object or list reads as text, never a blank value", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [
    email({ args: JSON.stringify({ to: "sam@example.com", headers: {}, cc: [] }) }),
  ]);
  const c = card(page);
  await expect(c.getByRole("definition").filter({ hasText: "(empty)" })).toBeVisible();
  await expect(c.getByRole("definition").filter({ hasText: "(empty list)" })).toBeVisible();
});

test("counts down the last minute, then leaves once it expires", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email({ expiresAt: Date.now() + 4_000 })]);
  const c = card(page);
  await expect(c).toContainText(/Expires in [34] s/);
  await expect(c).toContainText(/Expires in [12] s/);
  await expect(c).toHaveCount(0, { timeout: 6_000 });
  await expect(page.getByText("1 approval waiting")).toHaveCount(0);
});

test("never has focus on Allow, and Enter alone does nothing (AC7, UX-04)", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email()]);
  const allow = card(page).getByRole("button", { name: "Allow", exact: true });
  await expect(allow).toBeVisible();
  await expect(allow).not.toBeFocused();
  await allow.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  expect(s.posts).toEqual([]);
  await page.keyboard.press("Space");
  await expect(page.getByText(/^You approved: Send email \(just this once\)/)).toBeVisible();
  expect(s.posts).toEqual([
    {
      url: "/api/approvals/batch_1",
      body: { decisions: [{ approvalId: "appr_1", decision: "approve", scope: "once" }] },
    },
  ]);
  await expect(card(page)).toHaveCount(0);
});

test("a standing scope says it outlasts this request", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email()]);
  const c = card(page);
  await expect(c.getByRole("radio", { name: "Just this once" })).toBeChecked();
  await c.getByText("Always for example.com").click();
  await expect(c).toContainText("This keeps applying after this request.");
  await c.getByRole("button", { name: "Allow", exact: true }).click();
  await expect
    .poll(() => s.posts[0]?.body)
    .toEqual({
      decisions: [{ approvalId: "appr_1", decision: "approve", scope: "destination" }],
    });
});

test("an irreversible action asks for a passkey; cancelling does nothing", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [
    email({ risk: "irreversible", rule: "floor_irreversible", scopes: ["once"] }),
  ]);
  const c = card(page);
  await c.getByRole("button", { name: "Confirm with passkey…" }).click();
  await expect(c.getByRole("alert")).toHaveText("Not confirmed. Nothing was done.");
  // Only the challenge was asked for; no decision went out.
  expect(s.posts.map((p) => p.url)).toEqual(["/api/approvals/batch_1/options"]);
  await expect(c.getByRole("button", { name: "Confirm with passkey…" })).toBeEnabled();
});

test("Don't allow needs no passkey, even for an irreversible action", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [
    email({ risk: "irreversible", rule: "floor_irreversible", scopes: ["once"] }),
  ]);
  await card(page).getByRole("button", { name: "Don't allow" }).click();
  await expect(page.getByText(/^You declined: Send email/)).toBeVisible();
  expect(s.posts.map((p) => p.url)).toEqual(["/api/approvals/batch_1"]);
});

test("a request handled elsewhere says so and doesn't pretend it worked", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email()]);
  s.reply = { status: 409, json: { error: "stale" } };
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card(page).getByRole("alert")).toHaveText("This request changed. Review it again.");
  s.reply = { status: 500, json: {} };
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(card(page).getByRole("alert")).toHaveText(
    "That didn't reach your assistant. Try again.",
  );
});

test("an answer whose response was lost leaves a receipt that claims no answer", async ({
  page,
}) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email()]);
  // The server records the decision, then the response never arrives.
  await page.route(
    "/api/approvals/batch_1",
    (r) => {
      s.batches = [];
      return r.abort("connectionreset");
    },
    { times: 1 },
  );
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  // The batch left the list, but that alone doesn't say it was this answer that counted.
  await expect(
    page.getByText(/^No longer waiting: Send email · .*check the chat\.$/),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test("already_decided on a retry is already answered, not an error", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email()]);
  // Another tab decided first: the batch has left the server's pending rows.
  await page.route(
    "/api/approvals/batch_1",
    (r) => {
      s.batches = [];
      return r.fulfill({ status: 409, json: { error: "already_decided" } });
    },
    { times: 1 },
  );
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByText(/^Already answered: Send email/)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test.describe("the multi-action card (AC11)", () => {
  const three = () => [
    email(),
    email({
      approvalId: "appr_2",
      tool: "create_artifact",
      args: JSON.stringify({ name: "notes.md", content: "Plans" }),
      target: undefined,
      scopes: ["once", "hour"],
    }),
    email({
      approvalId: "appr_3",
      tool: "post_webhook",
      args: JSON.stringify({ url: "https://hooks.example/x" }),
      target: "hooks.example",
      risk: "irreversible",
      rule: "floor_irreversible",
      scopes: ["once"],
    }),
  ];

  test("counts what remains, takes one step-up, and sends removed items as denied", async ({
    page,
  }) => {
    const s = await stub(page);
    await page.goto("/");
    await ask(page, s, three());
    const c = card(page);
    await expect(c.getByRole("heading", { name: "3 actions need your OK" })).toBeVisible();
    await expect(c).toContainText("Send email · Save a file · Post webhook");
    await expect(c.getByRole("heading", { name: "3 of 3: Post webhook" })).toBeVisible();
    await expect(c).toContainText("Only once, because of Post webhook.");
    await expect(c.getByRole("button", { name: "Confirm 3 actions with passkey…" })).toBeVisible();

    await c.getByRole("button", { name: "Don't do this one: Post webhook" }).click();
    await expect(c).toContainText("Removed: Post webhook.");
    await expect(c.getByRole("button", { name: "Allow 2 actions" })).toBeVisible();
    // Without the irreversible item, the scopes both remaining items allow are offered.
    await expect(c.getByRole("radio")).toHaveCount(2);

    await c.getByRole("button", { name: "Undo: Post webhook" }).click();
    await expect(c.getByRole("button", { name: "Confirm 3 actions with passkey…" })).toBeVisible();
    await c.getByRole("button", { name: "Don't do this one: Post webhook" }).click();

    await c.getByRole("button", { name: "Allow 2 actions" }).click();
    await expect(page.getByText(/^You approved 2 of 3/)).toContainText("Declined: Post webhook.");
    expect(s.posts).toEqual([
      {
        url: "/api/approvals/batch_1",
        body: {
          decisions: [
            { approvalId: "appr_1", decision: "approve", scope: "once" },
            { approvalId: "appr_2", decision: "approve", scope: "once" },
            { approvalId: "appr_3", decision: "deny", scope: "once" },
          ],
        },
      },
    ]);
  });

  test("Always for names every host it would cover", async ({ page }) => {
    const s = await stub(page);
    await page.goto("/");
    await ask(page, s, [
      email(),
      email({
        approvalId: "appr_2",
        tool: "post_webhook",
        args: JSON.stringify({ url: "https://hooks.example/x" }),
        target: "hooks.example",
      }),
    ]);
    const c = card(page);
    await expect(c.getByRole("radio", { name: "Always for example.com" })).toHaveCount(0);
    await c.getByText("Always for example.com and hooks.example").click();
    await c.getByRole("button", { name: "Allow 2 actions" }).click();
    await expect
      .poll(() => s.posts[0]?.body)
      .toEqual({
        decisions: [
          { approvalId: "appr_1", decision: "approve", scope: "destination" },
          { approvalId: "appr_2", decision: "approve", scope: "destination" },
        ],
      });
  });

  test("with everything removed, only Done: allow none is left", async ({ page }) => {
    const s = await stub(page);
    await page.goto("/");
    await ask(page, s, three());
    const c = card(page);
    for (const name of ["Send email", "Save a file", "Post webhook"]) {
      await c.getByRole("button", { name: `Don't do this one: ${name}` }).click();
    }
    await expect(c.getByRole("button", { name: /^Allow|^Confirm/ })).toHaveCount(0);
    await c.getByRole("button", { name: "Done: allow none" }).click();
    await expect(page.getByText(/^You declined all 3/)).toBeVisible();
  });

  test("an item saved damaged can be declined or removed, never allowed", async ({ page }) => {
    const s = await stub(page);
    await page.goto("/");
    await ask(page, s, [
      email(),
      email({ approvalId: "appr_2", tool: "create_artifact", scopes: [] }),
    ]);
    const c = card(page);
    await expect(c).toContainText(
      "I can't let you allow Save a file: part of what I saved for it is damaged. Remove it to allow the rest.",
    );
    await expect(c.getByRole("button", { name: /^Allow/ })).toHaveCount(0);
    await c.getByRole("button", { name: "Don't do this one: Save a file" }).click();
    await c.getByRole("button", { name: "Allow 1 action" }).click();
    await expect
      .poll(() => s.posts[0]?.body)
      .toEqual({
        decisions: [
          { approvalId: "appr_1", decision: "approve", scope: "once" },
          { approvalId: "appr_2", decision: "deny", scope: "once" },
        ],
      });
  });

  test("a collapsed item still warns about a look-alike host", async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "New chat" }).click();
    await ask(page, s, [email(), email({ approvalId: "appr_2", target: "xn--exmple-cua.com" })]);
    const c = card(page);
    await expect(c.getByRole("button", { name: "Show: Send email" })).toBeVisible();
    await expect(c).toContainText("To: xn--exmple-cua.com");
    await expect(c.getByText("Looks like another address. Check it carefully.")).toBeVisible();
  });

  test("fits 375 px, opens only the first item there, and passes axe", async ({ page }) => {
    const s = await stub(page);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "New chat" }).click();
    await ask(page, s, three());
    const c = card(page);
    await expect(c.getByRole("button", { name: "Show: Save a file" })).toBeVisible();
    await expect(c).not.toContainText("notes.md");
    await c.getByRole("button", { name: "Show: Save a file" }).click();
    await expect(c).toContainText("notes.md");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
  });
});

test("Go to it moves focus to the waiting card", async ({ page }) => {
  const s = await stub(page);
  await page.goto("/");
  await ask(page, s, [email()]);
  await page.getByRole("button", { name: "Go to it" }).click();
  await expect(
    card(page).getByRole("heading", { name: "Send email · Needs your OK" }),
  ).toBeFocused();
});
