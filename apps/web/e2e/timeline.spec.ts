// SPDX-License-Identifier: Apache-2.0
// The run timeline (M3-09 AC1-5, m3-ux §3.1): the running header, step rows with tool
// cards, the taint marker, the collapsed "Worked for …" summary, the Show-work setting
// and the queued bubble's Cancel. Runs against the mock transport (`VITE_MOCK_CHAT=1`).
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

const provider = {
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
  price: { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6, verifiedAt: "2026-11-01", stale: false },
};
const SETTINGS = {
  displayName: "Sam",
  about: "",
  onboarded: true,
  model: null,
  providers: [provider],
  roles: {
    chat: { provider: "p1", model: "gpt-4.1-mini" },
    background: { provider: "p1", model: "gpt-4.1-mini", default: true },
    embedding: null,
  },
};

/** Every API read the chat and the Assistant page need, with a stateful Show-work choice. */
async function stub(page: Page, baseURL: string | undefined, showWork: string) {
  const assistant = { showWork };
  const writes: unknown[] = [];
  // The chat loads nothing from another origin (ADR 0010 D7).
  page.on("request", (req) => expect(new URL(req.url()).origin).toBe(baseURL));
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: SETTINGS }));
  await page.route("/api/settings/assistant", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: assistant });
    const body = route.request().postDataJSON();
    writes.push(body);
    assistant.showWork = body.showWork;
    return route.fulfill({ json: assistant });
  });
  await page.route(/\/api\/attachments\/config/, (route) =>
    route.fulfill({
      json: {
        maxBytes: 10 * 1024 * 1024,
        accept: ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json",
        types: [],
        model: null,
      },
    }),
  );
  return { assistant, writes };
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.keyboard.press("Enter");
}

test("a run shows its steps, tool card, taint marker and costed summary (AC1-3, AC5)", async ({
  page,
  baseURL,
}) => {
  await stub(page, baseURL, "collapsed");
  await page.goto("/");
  await send(page, "/mock timeline");
  const log = page.getByRole("log", { name: "Messages" });
  // The running header ticks while the step streams in (AC1).
  await expect(log).toContainText(/Working · /);
  // The scripted run finishes fast; the summary opens to the same steps (AC2).
  await expect(log).toContainText("Here's what I found in the docs.");
  await expect(log).toContainText(/Worked for .* · 1 tool · < \$0\.01/);
  await log.getByRole("button", { name: /Worked for/ }).click();
  // The taint marker sits on the step row itself, no opening needed (AC5).
  await expect(log.getByText("From the web: docs.example")).toBeVisible();
  // The step opens to the why and the tool card (AC3).
  await log.getByRole("button", { name: /Searching the docs/ }).click();
  await expect(
    log.getByText("Text from outside sources can try to steer me", { exact: false }),
  ).toBeVisible();
  await log.getByRole("button", { name: /fetch.*Done/ }).click();
  await expect(log.getByText("https://docs.example/guide", { exact: false })).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
});

test("hidden shows the summary only; expanded opens the tool cards (AC3)", async ({
  page,
  baseURL,
}) => {
  await stub(page, baseURL, "hidden");
  await page.goto("/");
  await send(page, "/mock timeline");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("Here's what I found in the docs.");
  await expect(log).toContainText(/Worked for .* · 1 tool/);
  await expect(log.getByText("Searching the docs")).toHaveCount(0);
});

test("expanded opens each tool card without another click (AC3)", async ({ page, baseURL }) => {
  await stub(page, baseURL, "expanded");
  await page.goto("/");
  await send(page, "/mock timeline");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("Here's what I found in the docs.");
  // The summary opens; the step row and its tool card are already open (AC3).
  await log.getByRole("button", { name: /Worked for/ }).click();
  await expect(log.getByText("https://docs.example/guide", { exact: false })).toBeVisible();
});

test("a failed tool stays visible beside the collapsed summary (AC2)", async ({
  page,
  baseURL,
}) => {
  await stub(page, baseURL, "collapsed");
  await page.goto("/");
  await send(page, "/mock timeline failed");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("The docs lookup failed, so this is from memory.");
  await expect(log).toContainText(/Worked for .* · 1 tool · 1 failed/);
  // The failure shows without opening the summary or the step.
  const failures = log.getByRole("list", { name: "Failed tools" });
  await expect(failures).toBeVisible();
  await expect(failures.getByText("fetch")).toBeVisible();
  await expect(failures.getByText("✕ Failed", { exact: true })).toBeVisible();
});

test("Settings › Assistant saves the Show-work choice", async ({ page, baseURL }) => {
  const { writes } = await stub(page, baseURL, "collapsed");
  await page.goto("/settings/assistant");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByRole("heading", { name: "Show work" })).toBeVisible();
  // The real input hides behind its label, so the click goes to the label's text.
  await page.getByText("Expanded", { exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  expect(writes).toEqual([{ showWork: "expanded" }]);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
});

test("a queued follow-up cancels from its bubble (AC4)", async ({ page, baseURL }) => {
  await stub(page, baseURL, "collapsed");
  await page.goto("/");
  await send(page, "/mock queued");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("Sends when this task finishes");
  await expect(log).toContainText("And the follow-up");
  await log.getByRole("button", { name: /Cancel/ }).click();
  await expect(log.getByText("Sends when this task finishes")).toHaveCount(0);
  await expect(log).toContainText("Here's what I found in the docs.");
});
