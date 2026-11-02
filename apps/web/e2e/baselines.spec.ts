// SPDX-License-Identifier: Apache-2.0
// Visual baselines for every MVP screen (M3-24 AC3): 375, 768 and 1280 px in both themes.
// Chat, the auth screens, Settings › Models, Usage and the vault-reset panel keep their
// baselines in their own specs; this file covers the rest of `src/routes.tsx`, onboarding and
// the not-found screen, each in a populated state.
//
// Determinism: the app loads no webfonts (Tailwind's system stack), animations are disabled by
// the Playwright config, and the browser clock is frozen at NOW (`page.clock.setFixedTime`,
// which fixes `Date.now`/`new Date()` while timers keep running). Every stubbed timestamp
// below is derived from that same frozen instant — fixed absolute dates where the UI prints
// one, mid-bucket offsets from NOW where it prints "2 h ago" style text — so nothing a screen
// computes from the clock (a running task's elapsed time, the activity log's Today/Yesterday
// groups, "recently learned", approval expiry) can depend on the run date. Re-record only
// inside the pinned Playwright image (see .github/workflows/visual.yml); host fonts differ.
//
// `ApprovalLink` (`/approvals/:approvalId`) is baselined in its "This request isn't waiting
// anymore" state: its populated state redirects to the chat scrolled to the approval card,
// which the chat baselines already cover.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-GB", timezoneId: "Europe/London" });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Fixed daylight moment for anything the UI prints as a date or time. */
const AT = Date.UTC(2026, 10, 1, 9, 30);
/**
 * The frozen browser "now": Sunday 1 Nov 2026, 11:00 in Europe/London (GMT), 90 minutes
 * after AT. The running task (started AT − 1 h) therefore reads "2h 30m", the log entry at
 * AT groups under Today and the one at AT − 1 d under Yesterday — on every run date.
 */
const NOW = Date.UTC(2026, 10, 1, 11, 0);
const now = NOW;

const SETTINGS = {
  displayName: "Sam",
  about: "Vegetarian. Based in Leeds.",
  onboarded: true,
  model: null,
  providers: [],
  roles: { chat: null, background: null, embedding: null },
  setup: { skipped: [], hidden: false },
};

const LIMITS = {
  taskBudgetMicroUsd: 500_000,
  dailyCapMicroUsd: 5_000_000,
  monthlyBudgetMicroUsd: 20_000_000,
  hardCapMicroUsd: null,
};

const batch = (n: number) => ({
  batchId: `batch_${n}`,
  conversationId: `c${n}`,
  conversationTitle: n === 1 ? "Orkney trip" : "Work",
  taskId: null,
  createdAt: now - n * 60_000,
  expiresAt: now + 2 * HOUR + 30 * 60_000,
  items: [
    {
      approvalId: `appr_${n}`,
      tool: "send_email",
      args: JSON.stringify({ to: [`friend${n}@example.com`], body: "Hello" }),
      target: "example.com",
      risk: "consequential",
      rule: "default_consequential",
      scopes: ["once", "hour"],
      expiresAt: now + 2 * HOUR + 30 * 60_000,
    },
  ],
});

const taskRow = (over: Record<string, unknown>) => ({
  id: "t1",
  title: "Research ferries to Orkney and summarise the options",
  conversationId: "c1",
  conversationTitle: "Orkney trip",
  kind: "chat",
  mode: "agent",
  status: "succeeded",
  limitKind: null,
  error: null,
  costMicroUsd: 123_400,
  unpricedCalls: 0,
  calls: 3,
  createdAt: AT - HOUR,
  updatedAt: AT,
  startedAt: AT - HOUR,
  finishedAt: AT,
  ...over,
});

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
  createdAt: AT - 30 * DAY,
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

const artifact = (over: { id: string; name: string } & Record<string, unknown>) => ({
  mediaType: "text/markdown",
  sizeBytes: 2048,
  conversationId: "c1",
  conversationTitle: "Orkney trip",
  taskId: null,
  turnId: "turn-1",
  createdAt: AT,
  ...over,
});

/** Every endpoint any screen below reads, answered with the seeded rows above. */
async function stubAll(page: Page) {
  // Registered first, matched last: anything unlisted answers empty instead of hitting the proxy.
  await page.route("/api/**", (r) => r.fulfill({ json: {} }));
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (r) => r.fulfill({ json: SETTINGS }));
  await page.route(/\/api\/attachments\/config/, (r) =>
    r.fulfill({ json: { maxBytes: 1024, accept: ".txt", types: [], model: null } }),
  );
  await page.route("/api/conversations", (r) =>
    r.fulfill({
      json: { conversations: [{ id: "c1", title: "Orkney trip", updatedAt: AT }] },
    }),
  );
  await page.route("/api/approvals?status=pending", (r) =>
    r.fulfill({ json: { batches: [batch(1), batch(2)] } }),
  );
  await page.route(/\/api\/approvals\?status=decided&since=\d+$/, (r) =>
    r.fulfill({ json: { batches: [] } }),
  );
  await page.route(
    (url) => url.pathname === "/api/tasks",
    (r) =>
      r.fulfill({
        json: {
          tasks: [
            taskRow({}),
            taskRow({
              id: "t2",
              title: "Draft the packing list",
              status: "running",
              finishedAt: null,
            }),
          ],
        },
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/tasks/t1",
    (r) => r.fulfill({ json: { task: taskRow({}) } }),
  );
  await page.route(
    (url) => url.pathname.startsWith("/api/artifacts"),
    (r) => {
      const url = new URL(r.request().url());
      const [, , , id, content] = url.pathname.split("/");
      const files = [
        artifact({ id: "plan", name: "trip-plan.md" }),
        artifact({ id: "totals", name: "totals.csv", mediaType: "text/csv", sizeBytes: 512 }),
      ];
      if (!id) return r.fulfill({ json: { artifacts: files } });
      const found = files.find((f) => f.id === id);
      if (!found) return r.fulfill({ status: 404, json: { error: "not_found" } });
      if (!content) return r.fulfill({ json: found });
      return r.fulfill({ body: "# Kirkwall\n\nFerry at **06:30**.", contentType: "text/markdown" });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/activity/log",
    (r) =>
      r.fulfill({
        json: {
          entries: [
            {
              id: 9,
              at: AT,
              kind: "tools",
              title: "Changed a tool's setting",
              action: "policy.override",
              result: "ok",
              target: "send_email",
              detail: { tool: "send_email", from: "ask", to: "auto", riskClass: "egress" },
            },
            {
              id: 8,
              at: AT - DAY,
              kind: "approvals",
              title: "Approved an action",
              action: "approval.approve",
              result: "ok",
              target: "b1/a1",
              detail: { scope: "hour" },
            },
          ],
          next: null,
          retentionDays: 365,
        },
      }),
  );
  await page.route("/api/settings/memory", (r) => r.fulfill({ json: { learnFromChats: true } }));
  // One handler for /api/memory and /api/memory/proposals (glob order would shadow the latter).
  await page.route("/api/memory**", (r) => {
    if (new URL(r.request().url()).pathname.endsWith("/proposals"))
      return r.fulfill({
        json: {
          expired: 0,
          proposals: [
            {
              ...note({
                id: "p1",
                text: "Sam is moving to York in spring",
                trust: "inferred",
                createdAt: now - 2 * HOUR - 30 * 60_000,
              }),
              targets: [],
            },
          ],
        },
      });
    return r.fulfill({
      json: {
        memories: [
          note({}),
          note({
            id: "n2",
            text: "Prefers trains to planes",
            trust: "inferred",
            createdAt: now - 2 * HOUR - 30 * 60_000,
          }),
          note({
            id: "n3",
            kind: "instruction",
            text: "Always answer in British English",
            source: "memory_screen",
            conversation: null,
          }),
        ],
      },
    });
  });
  await page.route("/api/settings/assistant", (r) => r.fulfill({ json: { showWork: true } }));
  await page.route("/api/settings/setup", (r) => r.fulfill({ json: SETTINGS.setup }));
  await page.route("/api/settings/tools", (r) =>
    r.fulfill({
      json: {
        tools: [
          {
            name: "web_search",
            description: "Search the web",
            riskClass: "read",
            egress: true,
            override: null,
            default: "auto",
            locked: false,
          },
          {
            name: "send_email",
            description: "Send an email",
            riskClass: "egress",
            egress: true,
            override: "ask",
            default: "ask",
            locked: false,
          },
        ],
      },
    }),
  );
  await page.route("/api/settings/retention", (r) =>
    r.fulfill({
      json: {
        messageDays: null,
        toolOutputDays: 30,
        memoryInboxDays: 14,
        defaults: { messageDays: null, toolOutputDays: 30, memoryInboxDays: 14 },
        bounds: {
          messageDays: { min: 1, max: 3650 },
          toolOutputDays: { min: 1, max: 3650 },
          memoryInboxDays: { min: 1, max: 365 },
        },
      },
    }),
  );
  await page.route("/api/settings/spending", (r) =>
    r.fulfill({
      json: {
        settings: LIMITS,
        defaults: LIMITS,
        executionLimits: { callsPerMessage: 8, toolCallsPerMessage: 20, stepsPerTask: 200 },
        todayMicroUsd: 120_000,
        monthMicroUsd: 3_420_000,
        warning: null,
        hardCapReached: false,
        month: Date.UTC(2026, 10, 1),
        userId: "u",
      },
    }),
  );
  await page.route("/api/passkeys", (r) =>
    r.fulfill({
      json: {
        passkeys: [{ id: "pk1", name: "MacBook", createdAt: AT - 30 * DAY, lastUsedAt: AT - DAY }],
      },
    }),
  );
  await page.route("/api/sessions", (r) =>
    r.fulfill({
      json: {
        sessions: [
          {
            id: "s1",
            createdAt: AT - DAY,
            lastSeenAt: AT,
            expiresAt: AT + 30 * DAY,
            current: true,
          },
        ],
      },
    }),
  );
  await page.route("/api/recovery-codes", (r) => r.fulfill({ json: { remaining: 8 } }));
  await page.route("/api/settings/grants", (r) =>
    r.fulfill({
      json: {
        grants: [
          {
            id: "g1",
            tool: "send_email",
            scope: "destination",
            destination: "example.com",
            createdAt: AT - DAY,
          },
        ],
      },
    }),
  );
  await page.route("/api/account", (r) =>
    r.fulfill({ json: { id: "u", role: "owner", createdAt: AT - 30 * DAY } }),
  );
  await page.route("/api/exports", (r) => r.fulfill({ json: { exports: [] } }));
}

/** name → [path, text that proves the populated screen rendered] */
const SCREENS: Record<string, [string, string]> = {
  inbox: ["/inbox", "friend1@example.com"],
  "approval-link": ["/approvals/appr_missing", "This request isn't waiting anymore"],
  tasks: ["/activity/tasks", "Research ferries to Orkney"],
  "task-details": ["/activity/tasks/t1", "Research ferries to Orkney"],
  outputs: ["/activity/outputs", "trip-plan.md"],
  "output-details": ["/activity/outputs/plan", "Kirkwall"],
  "activity-log": ["/activity/log", "Changed a tool's setting"],
  memory: ["/memory", "Sam lives in Leeds"],
  "memory-waiting": ["/memory/waiting", "Sam is moving to York in spring"],
  settings: ["/settings", "Privacy & security"],
  "settings-assistant": ["/settings/assistant", "Vegetarian. Based in Leeds."],
  "settings-agent-engine": ["/settings/agent-engine", "Built-in engine"],
  "settings-computer": ["/settings/computer", "Not set up."],
  "settings-apps": ["/settings/apps", "Send an email"],
  "settings-memory": ["/settings/memory", "Learn from our chats"],
  "settings-spending": ["/settings/spending", "This month: about $3.42"],
  "settings-privacy": ["/settings/privacy", "MacBook"],
  "settings-deployment": ["/settings/deployment", "Deployment"],
  "not-found": ["/no-such-screen", "This page doesn't exist"],
};

async function shoot(page: Page, name: string, colorScheme: string, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
  await expect(page).toHaveScreenshot(`${name}-${colorScheme}-${width}.png`, { fullPage: true });
}

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1280]) {
    for (const [name, [path, ready]] of Object.entries(SCREENS)) {
      test(`${name}, ${colorScheme}, ${width} px: axe clean, no sideways scroll, baseline`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme });
        await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
        await page.clock.setFixedTime(NOW);
        await stubAll(page);
        await page.goto(path);
        await expect(page.getByText(ready).first()).toBeVisible();
        await shoot(page, name, colorScheme, width);
      });
    }

    test(`onboarding, ${colorScheme}, ${width} px: every step's baseline`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.clock.setFixedTime(NOW);
      await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
      await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
      await page.route("/api/settings**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/model/test"))
          return route.fulfill({ json: { ok: true, latencyMs: 412, tools: true, reply: "ready" } });
        if (path.endsWith("/spending"))
          return route.fulfill({
            json: {
              settings: LIMITS,
              defaults: LIMITS,
              executionLimits: { callsPerMessage: 8, toolCallsPerMessage: 20, stepsPerTask: 200 },
              todayMicroUsd: 0,
              monthMicroUsd: 0,
              warning: null,
              hardCapReached: false,
              month: Date.UTC(2026, 10, 1),
              userId: "u",
            },
          });
        if (path.endsWith("/model"))
          return route.fulfill({
            json: {
              displayName: "Sam",
              about: "",
              onboarded: false,
              model: {
                kind: "openai-chat",
                providerId: "openai",
                baseUrl: "https://api.openai.com/v1",
                model: "gpt-4.1-mini",
                key: { last4: "WXYZ" },
              },
            },
          });
        if (path.endsWith("/settings"))
          return route.fulfill({
            json: { displayName: "", about: "", onboarded: false, model: null },
          });
        return route.fulfill({ status: 204 });
      });

      await page.goto("/onboarding");
      await expect(page.getByLabel("What should your assistant call you?")).toBeVisible();
      await shoot(page, "onboarding-about", colorScheme, width);

      await page.getByLabel("What should your assistant call you?").fill("Sam");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("radiogroup", { name: "How your assistant reaches a model" }),
      ).toBeVisible();
      await shoot(page, "onboarding-model", colorScheme, width);

      await page.getByText("OpenAI", { exact: true }).click();
      await page.getByLabel("API key", { exact: true }).fill("test-key-WXYZ");
      await page.getByRole("button", { name: "Save and test" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("Monthly budget: $20")).toBeVisible();
      await shoot(page, "onboarding-costs", colorScheme, width);

      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { name: "How I ask before acting" })).toBeVisible();
      await shoot(page, "onboarding-safety", colorScheme, width);

      await page.getByRole("button", { name: "Continue" }).click();
      await expect(
        page.getByRole("button", { name: "Remember that I'm vegetarian." }),
      ).toBeVisible();
      await shoot(page, "onboarding-first-chat", colorScheme, width);
    });
  }
}
