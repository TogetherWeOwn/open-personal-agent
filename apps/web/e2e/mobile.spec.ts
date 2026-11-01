// SPDX-License-Identifier: Apache-2.0
// The 375 px pass (M3-24 AC2; m3-ux §4.9): chat, approvals, tasks, memory, usage, outputs and
// settings are usable on a 375 × 667 phone. The screens' own specs cover their data states.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

test.use({ viewport: { width: 375, height: 667 } });

const HOUR = 3_600_000;

interface Stub {
  batches: Record<string, unknown>[];
}

async function stub(page: Page): Promise<Stub> {
  const s: Stub = { batches: [] };
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (r) =>
    r.fulfill({
      json: {
        onboarded: true,
        providers: [],
        roles: { chat: null, background: null, embedding: null },
      },
    }),
  );
  await page.route("/api/approvals?status=pending", (r) =>
    r.fulfill({ json: { batches: s.batches } }),
  );
  // Tasks and the Activity log answered with loaded rows, so `fits` measures populated screens
  // there, not the empty state. Outputs, Memory and Usage keep that check in their own specs.
  const now = Date.now();
  await page.route(
    (url) => url.pathname === "/api/tasks",
    (r) =>
      r.fulfill({
        json: {
          tasks: [
            {
              id: "t1",
              title: "Research every supplier for the winter collection and summarise the options",
              conversationId: "c1",
              conversationTitle: "Planning the winter collection launch with Sam and Priya",
              kind: "chat",
              mode: "agent",
              status: "running",
              limitKind: null,
              error: null,
              costMicroUsd: 123_400,
              unpricedCalls: 0,
              calls: 3,
              createdAt: now - 600_000,
              updatedAt: now - 300_000,
              startedAt: now - 300_000,
              finishedAt: null,
            },
          ],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/activity/log",
    (r) =>
      r.fulfill({
        json: {
          entries: [
            {
              id: 9,
              at: now - 60_000,
              kind: "tools",
              title: "Changed a tool's setting after reviewing what it can send and where",
              action: "policy.override",
              result: "ok",
              target: "send_email_to_external_recipients",
              detail: { from: "ask", to: "auto" },
            },
          ],
          next: null,
          retentionDays: 365,
        },
      }),
  );
  return s;
}

const box = async (l: Locator) => {
  const b = await l.boundingBox();
  if (!b) throw new Error("not on screen");
  return b;
};

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

const tabs = (page: Page) => page.getByRole("navigation", { name: "Main" });

// Each address the AC names, with every Settings page; none scrolls sideways.
const SCREENS = [
  "/inbox",
  "/activity/tasks",
  "/activity/outputs",
  "/activity/log",
  "/memory",
  "/usage",
  "/settings",
  "/settings/assistant",
  "/settings/models",
  "/settings/agent-engine",
  "/settings/computer",
  "/settings/apps",
  "/settings/memory",
  "/settings/spending",
  "/settings/privacy",
  "/settings/deployment",
];

// The screens above whose stub serves loaded rows: wait for a row, so `fits` proves the
// populated layout fits, not just the heading and the empty state.
const LOADED: Record<string, string> = {
  "/activity/tasks": "Research every supplier for the winter collection and summarise the options",
  "/activity/log": "send_email_to_external_recipients: Asks you first → Does it without asking",
};

for (const path of SCREENS) {
  test(`${path} fits 375 px with no axe violations`, async ({ page }) => {
    await stub(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(tabs(page)).toBeVisible();
    const loaded = LOADED[path];
    if (loaded) await expect(page.getByText(loaded)).toBeVisible();
    await fits(page);
  });
}

test("the four tabs line up, You included", async ({ page }) => {
  await stub(page);
  await page.goto("/inbox");
  const t = tabs(page);
  const centres = await Promise.all(
    [
      t.getByRole("link", { name: "Chat" }),
      t.getByRole("link", { name: "Inbox" }),
      t.getByRole("link", { name: "Activity" }),
      t.getByRole("button", { name: "You" }),
    ].map(async (l) => {
      const b = await box(l);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, h: b.height };
    }),
  );
  for (const c of centres) {
    expect(Math.abs(c.y - (centres[0]?.y ?? 0))).toBeLessThan(2);
    expect(c.h).toBeGreaterThanOrEqual(44);
  }
  // Each sits in the middle of its quarter of the bar.
  for (const [i, c] of centres.entries()) {
    expect(Math.abs(c.x - (375 / 8) * (2 * i + 1))).toBeLessThan(2);
  }
});

test("Activity's three screens link to each other", async ({ page }) => {
  await stub(page);
  await page.goto("/activity");
  const activity = page.getByRole("navigation", { name: "Activity" });
  await expect(activity.getByRole("link", { name: "Tasks" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await activity.getByRole("link", { name: "Outputs" }).click();
  await expect(page).toHaveURL(/\/activity\/outputs$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Outputs");
  await activity.getByRole("link", { name: "Activity log" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Activity log");
  await activity.getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
});

test("a Settings page links back to the list instead of wrapping every page's name", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/settings");
  await page.getByRole("link", { name: "Privacy & security" }).click();
  await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeHidden();
  await page.getByRole("link", { name: "All settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("link", { name: "Deployment" })).toBeVisible();
});

test("the composer keeps the message box wide, and the tab bar steps aside while typing", async ({
  page,
}) => {
  await stub(page);
  await page.goto("/");
  await page.getByRole("option", { name: "New chat" }).click();
  const message = page.getByRole("textbox", { name: "Message" });
  expect((await box(message)).width).toBeGreaterThanOrEqual(200);
  expect((await box(page.getByRole("button", { name: "Attach" }))).width).toBeGreaterThanOrEqual(
    44,
  );
  await message.click();
  await expect(tabs(page)).toBeHidden();
  await fits(page);
});

test("an approval card fits one screen, with its buttons full-width and stacked", async ({
  page,
}) => {
  const s = await stub(page);
  await page.goto("/");
  await page.getByRole("option", { name: "New chat" }).click();
  await page.getByRole("button", { name: "Chat options" }).click();
  const href = await page
    .getByRole("menuitem", { name: "Files in this chat" })
    .getAttribute("href");
  await page.keyboard.press("Escape");
  const conversationId = new URL(href ?? "", "http://x").searchParams.get("conversation");
  s.batches = [
    {
      batchId: "batch_1",
      conversationId,
      conversationTitle: "Plans",
      taskId: null,
      createdAt: Date.now(),
      expiresAt: Date.now() + 23 * HOUR,
      items: [
        {
          approvalId: "appr_1",
          tool: "send_email",
          args: JSON.stringify({
            to: ["sam@example.com"],
            subject: "Friday",
            body: "Hi Sam,\nSee you on Friday at the station. I'll bring the tickets.",
          }),
          target: "example.com",
          risk: "consequential",
          rule: "default_consequential",
          scopes: ["once", "hour", "destination"],
          expiresAt: Date.now() + 23 * HOUR,
        },
      ],
    },
  ];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const card = page.getByRole("region", { name: "Send email · Needs your OK" });
  await expect(card).toBeVisible();
  expect((await box(card)).height).toBeLessThanOrEqual(667);
  const allow = await box(card.getByRole("button", { name: "Allow", exact: true }));
  const deny = await box(card.getByRole("button", { name: "Don't allow" }));
  expect(allow.width).toBe(deny.width);
  expect(allow.width).toBeGreaterThan(375 - 100);
  expect(allow.height).toBeGreaterThanOrEqual(44);
  expect(deny.height).toBeGreaterThanOrEqual(44);
  expect(deny.y - (allow.y + allow.height)).toBeGreaterThanOrEqual(8);
  await fits(page);
});
