// SPDX-License-Identifier: Apache-2.0
// The Inbox, its badge and the deep links (M3-07 AC8; m3-ux §1.2, §3.4): approvals across
// conversations, acted on in place, at 375 px too.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const HOUR = 3_600_000;

const batch = (n: number, conversationId = `c${n}`, over: Record<string, unknown> = {}) => ({
  batchId: `batch_${n}`,
  conversationId,
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
  ...over,
});

interface Stub {
  batches: Record<string, unknown>[];
  fail: boolean;
  posts: string[];
  decided: Record<string, unknown>[];
}

async function stub(page: Page, batches: Record<string, unknown>[]): Promise<Stub> {
  const s: Stub = { batches, fail: false, posts: [], decided: [] };
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (r) =>
    r.fulfill({ json: { onboarded: true, providers: [], roles: { chat: null } } }),
  );
  await page.route("/api/approvals?status=pending", (r) =>
    s.fail ? r.fulfill({ status: 500, json: {} }) : r.fulfill({ json: { batches: s.batches } }),
  );
  await page.route(/\/api\/approvals\?status=decided&since=\d+$/, (r) =>
    r.fulfill({ json: { batches: s.decided } }),
  );
  await page.route(/\/api\/approvals\/[^/?]+$/, (r) => {
    const id = new URL(r.request().url()).pathname.split("/").pop() ?? "";
    s.posts.push(id);
    const { decisions } = r.request().postDataJSON() as { decisions: unknown[] };
    const answered = s.batches.find((b) => b.batchId === id);
    if (answered) s.decided.unshift({ ...answered, decisions, decidedAt: Date.now() });
    s.batches = s.batches.filter((b) => b.batchId !== id);
    return r.fulfill({ json: { status: "resumed" } });
  });
  return s;
}

const inbox = (page: Page) => page.getByRole("region", { name: /^Needs your OK/ });

test("a chat's name can't hide characters that reorder its line", async ({ page }) => {
  await stub(page, [batch(1, "c1", { conversationTitle: "Trip\u202e\u200b plans" })]);
  await page.goto("/inbox");
  const card = inbox(page).getByRole("region", { name: /^Send email/ });
  await expect(card.getByRole("link", { name: "Open in Trip plans" })).toBeVisible();
  await expect(card).toHaveAccessibleName("Send email · Needs your OK in Trip plans");
  expect(await card.textContent()).not.toMatch(/[\u202e\u200b]/);
});

test("lists what waits across chats, badges it, and acts in place", async ({ page }) => {
  const s = await stub(page, [batch(1), batch(2, "c2", { taskId: "t2" })]);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "Needs your OK (2)" })).toBeVisible();
  await expect(page).toHaveTitle("(2) Inbox · Open Personal Agent");
  await expect(page.getByRole("link", { name: /^Inbox\s*,\s*2 waiting$/ }).first()).toBeVisible();
  const cards = inbox(page).getByRole("region", { name: /^Send email · Needs your OK in Chat/ });
  await expect(cards).toHaveCount(2);
  // Soonest expiry first, each with its chat (through its deep link) and its task.
  await expect(cards.first()).toContainText("friend1@example.com");
  await expect(cards.first().getByRole("link", { name: "Open in Chat 1" })).toHaveAttribute(
    "href",
    "/approvals/appr_1",
  );
  await expect(cards.nth(1).getByRole("link", { name: "See the task" })).toHaveAttribute(
    "href",
    "/activity/tasks/t2",
  );
  // There is deliberately no approve-all.
  await expect(page.getByRole("button", { name: /^(approve|allow) all/i })).toHaveCount(0);

  await cards.first().getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Needs your OK (1)" })).toBeVisible();
  await expect(page).toHaveTitle("(1) Inbox · Open Personal Agent");
  expect(s.posts).toEqual(["batch_1"]);
  await page.getByRole("button", { name: "Done today (1)" }).click();
  await expect(page.getByText(/^You approved: Send email \(just this once\)/)).toBeVisible();
  // The receipt is read back from the server, so a reload keeps it.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Needs your OK (1)" })).toBeVisible();
  await page.getByRole("button", { name: "Done today (1)" }).click();
  await expect(page.getByText(/^You approved: Send email \(just this once\)/)).toBeVisible();
});

test("says when nothing waits, and when it couldn't load", async ({ page }) => {
  const s = await stub(page, []);
  s.fail = true;
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { name: "I couldn't load your inbox." })).toBeVisible();
  s.fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Nothing needs you right now." })).toBeVisible();
  await expect(page.getByRole("link", { name: "See Activity" })).toBeVisible();
  await expect(page).toHaveTitle("Inbox · Open Personal Agent");
});

test("lists 20, then Show all", async ({ page }) => {
  await stub(
    page,
    Array.from({ length: 23 }, (_, i) => batch(i + 1)),
  );
  await page.goto("/inbox");
  const cards = inbox(page).getByRole("region", { name: /^Send email · Needs your OK in Chat/ });
  await expect(cards).toHaveCount(20);
  await page.getByRole("button", { name: "Show all 23" }).click();
  await expect(cards).toHaveCount(23);
});

test("a deep link opens its chat with focus on the card", async ({ page }) => {
  const s = await stub(page, []);
  await page.goto("/");
  // The open chat's ID, from its "Files in this chat" link.
  await page.getByRole("button", { name: "Chat options" }).click();
  const href = await page
    .getByRole("menuitem", { name: "Files in this chat" })
    .getAttribute("href");
  await page.keyboard.press("Escape");
  const id = new URL(href ?? "", "http://x").searchParams.get("conversation") ?? "";
  s.batches = [batch(1, id)];
  await page.getByRole("link", { name: "Inbox" }).first().click();
  // The hidden chat shows the same card; the Inbox's keeps its own ids.
  await expect(page.locator("#inbox-approval-batch_1")).toHaveCount(1);
  await expect(page.locator("#approval-batch_1")).toHaveCount(1);
  await page.getByRole("link", { name: "Open in Chat 1" }).click();
  await expect(page).toHaveURL(`/c/${id}`);
  await expect(page.getByRole("heading", { name: "Send email · Needs your OK" })).toBeFocused();
});

test("a deep link to a request that no longer waits says so", async ({ page }) => {
  await stub(page, [batch(1)]);
  await page.goto("/approvals/appr_gone");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This request isn't waiting anymore",
  );
  await page.getByRole("link", { name: "Go to your Inbox" }).click();
  await expect(page).toHaveURL("/inbox");
});

test("a deep link answered elsewhere since the last read doesn't open the chat", async ({
  page,
}) => {
  const s = await stub(page, [batch(1)]);
  await page.goto("/inbox");
  await expect(page.getByRole("link", { name: "Open in Chat 1" })).toBeVisible();
  s.batches = []; // another tab answered it; this tab's list still has it
  await page.getByRole("link", { name: "Open in Chat 1" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This request isn't waiting anymore",
  );
  await expect(page).toHaveURL("/approvals/appr_1");
});

for (const width of [375, 1280]) {
  test(`the Inbox fits ${width} px, badges the tab bar there, and passes axe`, async ({ page }) => {
    await stub(page, [batch(1), batch(2)]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: "Needs your OK (2)" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^Inbox\s*,\s*2 waiting$/ }).locator("visible=true"),
    ).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
  });
}
