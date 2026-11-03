// SPDX-License-Identifier: Apache-2.0
// The optional endpoint-generic live-model step of `verify:cloudflare` (M3-25 AC1/AC2). It runs
// only with its step-level secrets: without them the whole file skips, and the report says so.
// With them it configures providers through the deployed app's normal model settings, runs the
// settings Test probe as preflight (a failure stops that adapter and is recorded), then runs the
// F-3.5 AC1 task — fetch three pages, compare them, save the summary as an artifact — on the
// workers-ai binding and the chat, Responses and Messages adapters, recording the model id,
// tokens, cost against the price table and the artifact per adapter. A per-adapter failure is
// that adapter's result, never a skip of the others.
import fs from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const OPENAI_BASE = process.env.LIVE_MODEL_OPENAI_BASE_URL;
const ANTHROPIC_BASE = process.env.LIVE_MODEL_ANTHROPIC_BASE_URL;
const API_KEY = process.env.LIVE_MODEL_API_KEY;
const RESULTS = process.env.LIVE_MODELS_JSON ?? "test-results/live-models.json";
const storageState = process.env.OPA_STORAGE_STATE;
if (storageState) test.use({ storageState });

const CONFIGURED = Boolean(API_KEY && (OPENAI_BASE || ANTHROPIC_BASE));

// The model ids the run must never pick, whatever the endpoint lists.
const BANNED = new Set(["gpt-5.6-terra", "gpt-6-sol"]);
const banned = (id: string) => BANNED.has(id) || /terra/i.test(id);

// Cloudflare's `/ai/v1` base has no `GET /models` (405): when listing is unavailable the run
// probes this small curated list instead. Order is task-capable first: the priced starter probes
// OK with tool calls but never completes the compare-and-save task (it fills example-domain text
// until the artifact cap), while the path's Responses route only serves the GPT-OSS entries and
// only without streaming. Every entry is in the provider's tool-capable set; unpriced ones record
// `unpriced` with token counts per the spec, never a silent pass.
const CURATED_MODELS = [
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
];

// Three small stable pages for the compare-and-save task.
const PAGES = ["https://example.com", "https://example.org", "https://example.net"];

type Adapter = "workers-ai-binding" | "openai-chat" | "openai-responses" | "anthropic-messages";

interface AdapterResult {
  adapter: Adapter;
  model: string | null;
  testMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
  expectedMicroUsd: number | null;
  cost: "match" | "mismatch" | "unpriced" | null;
  artifactId: string | null;
  artifactName: string | null;
  ok: boolean;
  error: string | null;
}

const ADAPTERS = new Set<Adapter>([
  "workers-ai-binding",
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
]);

const results = new Map<Adapter, AdapterResult>();

/** Rows already on disk, if a restarted worker left them there. */
function readRows(): AdapterResult[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
    return Array.isArray(parsed) ? (parsed as AdapterResult[]) : [];
  } catch {
    return [];
  }
}

/** The endpoint key never reaches the report: an endpoint that echoes it fails redacted. */
const scrubKey = (value: string | null) =>
  value !== null && API_KEY && API_KEY.length >= 8
    ? value.split(API_KEY).join("[redacted]")
    : value;

function record(result: AdapterResult) {
  result = { ...result, model: scrubKey(result.model), error: scrubKey(result.error) };
  results.set(result.adapter, result);
  // Playwright restarts the worker after a failed test, so a later adapter starts with an
  // empty module-level Map: fold in rows already on disk so earlier adapters are never lost.
  for (const row of readRows()) {
    if (row && ADAPTERS.has(row.adapter) && !results.has(row.adapter)) {
      results.set(row.adapter, row);
    }
  }
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(RESULTS, `${JSON.stringify([...results.values()], null, 2)}\n`);
  console.log(
    `live-models: ${result.adapter} ${result.ok ? "PASS" : "FAIL"} model=${result.model ?? "-"} ` +
      `tokens=${result.inputTokens ?? "-"}/${result.outputTokens ?? "-"} ` +
      `cost=${result.costMicroUsd ?? "-"}uUSD/${result.cost ?? "-"} ` +
      `artifact=${result.artifactId ?? "-"}${result.error ? ` error=${result.error}` : ""}`,
  );
}

/** The deployment's own API, with the claimed session's cookies. */
async function api(page: Page, method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
  // Writes pass the exact-origin guard, which needs this deployment's Origin (browser fetch
  // sends it; page.request does not).
  const origin = new URL(page.url()).origin;
  const res = await page.request.fetch(path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : { origin }),
    },
    data: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status(), json };
}

/**
 * The endpoint's model ids from its own list call, in its order, without the banned ones —
 * plus whether they came from the curated fallback (which is already task-capable-ordered,
 * so the pick keeps that order instead of preferring a priced entry).
 */
async function listModels(
  baseUrl: string,
  adapter: Adapter,
): Promise<{ ids: string[]; curated: boolean }> {
  // The base URL already holds the version path (for example `https://host/v1`), as the
  // provider adapters treat it: append `/models`, never another `/v1`.
  const root = baseUrl.replace(/\/+$/, "");
  // Defense in depth: the key must never follow a redirect (fetch strips Authorization
  // cross-origin, but not x-api-key) or leave HTTPS, whatever the operator configured.
  // The server-side provider validation (https-only, no query/hash) runs first via addProvider.
  let scheme: string | null = null;
  try {
    scheme = new URL(root).protocol;
  } catch {
    scheme = null;
  }
  if (scheme !== "https:") throw new Error("the endpoint URL must use https");
  const headers: Record<string, string> =
    adapter === "anthropic-messages"
      ? {
          authorization: `Bearer ${API_KEY}`,
          "x-api-key": API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        }
      : { authorization: `Bearer ${API_KEY}` };
  const res = await fetch(`${root}/models`, {
    headers,
    redirect: "error",
  });
  // Cloudflare's `/ai/v1` base has no list call (405, and 404 on some bases): fall back to
  // the curated free tool-calling `@cf/` list instead of failing the adapter. Anything else
  // still throws so a real auth or server failure stays visible.
  if (!res.ok && (res.status === 404 || res.status === 405)) {
    const picked = CURATED_MODELS.filter((id) => !banned(id));
    if (!picked.length) throw new Error("the curated list has no usable model");
    console.log(`live-models: ${adapter} GET /models HTTP ${res.status}, using curated list`);
    return { ids: picked, curated: true };
  }
  if (!res.ok) throw new Error(`GET /models: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: unknown }[] } | { id?: unknown }[];
  const data = Array.isArray(body) ? body : (body.data ?? []);
  const ids = data.map((m) => m?.id).filter((id): id is string => typeof id === "string");
  const picked = ids.filter((id) => !banned(id));
  if (!picked.length) throw new Error("the endpoint listed no usable model");
  return { ids: picked, curated: false };
}

interface TestResponse {
  ok: boolean;
  latencyMs?: number;
  tools?: boolean;
  toolProbe?: string;
  price?: { inputUsdPerMTok: number; outputUsdPerMTok: number } | null;
  error?: { code: string; message: string };
}

interface ProviderRow {
  id: string;
  kind: string;
  api: string;
  providerId: string | null;
  baseUrl: string | null;
  model: string | null;
}

async function providerRows(page: Page): Promise<ProviderRow[]> {
  const { status, json } = await api(page, "GET", "/api/settings");
  if (status !== 200 || !json || !Array.isArray(json.providers)) {
    throw new Error(`GET /api/settings: HTTP ${status}`);
  }
  return json.providers as ProviderRow[];
}

interface UsageLine {
  providerId: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
}

async function usageByModel(page: Page, model: string) {
  const { status, json } = await api(page, "GET", "/api/usage");
  if (status !== 200 || !json) throw new Error(`GET /api/usage: HTTP ${status}`);
  // Per-model lines live under `month.groups`; `breakdowns` holds conversation/task/day rows.
  const groups = (
    ((json.month as { groups?: { lines?: UsageLine[] }[] }).groups ?? []) as {
      lines?: UsageLine[];
    }[]
  ).flatMap((g) => g.lines ?? []);
  const lines = groups.filter((l) => l.model === model);
  return {
    inputTokens: lines.reduce((s, l) => s + l.inputTokens, 0),
    outputTokens: lines.reduce((s, l) => s + l.outputTokens, 0),
    costMicroUsd: lines.reduce((s, l) => s + (l.costMicroUsd ?? 0), 0),
  };
}

interface PendingItem {
  approvalId: string;
  risk: string;
  scopes: string[];
}

/**
 * Decides every pending batch the task raised, approve-once for reversible work. A batch with an
 * irreversible item needs a passkey the run has none of, so the task stops and says so.
 */
async function decidePending(page: Page) {
  const { status, json } = await api(page, "GET", "/api/approvals");
  if (status !== 200 || !json) throw new Error(`GET /api/approvals: HTTP ${status}`);
  const batches = (json.batches ?? []) as { batchId: string; items: PendingItem[] }[];
  for (const batch of batches) {
    if (!batch.items.length) continue;
    if (batch.items.some((i) => i.risk === "irreversible")) {
      throw new Error(`approval batch ${batch.batchId} needs a passkey step-up`);
    }
    const decisions = batch.items.map((i) => ({
      approvalId: i.approvalId,
      decision: "approve",
      scope: i.scopes.includes("once") ? "once" : (i.scopes[0] ?? "once"),
    }));
    const decided = await api(page, "POST", `/api/approvals/${batch.batchId}`, { decisions });
    if (decided.status !== 200 || !decided.json || "error" in decided.json) {
      throw new Error(`deciding ${batch.batchId}: HTTP ${decided.status}`);
    }
  }
}

interface ArtifactRow {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
}

async function artifactSince(page: Page, since: number): Promise<ArtifactRow | null> {
  const { status, json } = await api(page, "GET", "/api/artifacts");
  if (status !== 200 || !json || !Array.isArray(json.artifacts)) return null;
  const rows = (json.artifacts as ArtifactRow[]).filter((a) => a.createdAt >= since);
  return rows.at(-1) ?? null;
}

const fail = (adapter: Adapter, error: unknown): AdapterResult => ({
  adapter,
  model: null,
  testMs: null,
  inputTokens: null,
  outputTokens: null,
  costMicroUsd: null,
  expectedMicroUsd: null,
  cost: null,
  artifactId: null,
  artifactName: null,
  ok: false,
  // The bound must fit the longest diagnostic message whole: the artifact-timeout error
  // carries a ~300-char log tail at its end, so a shorter cap would cut the tail first.
  error: String(error instanceof Error ? error.message : error).slice(0, 500),
});

test.describe("live models on a configured endpoint", () => {
  test.skip(!CONFIGURED, "no LIVE_MODEL_* secrets: the endpoint-generic live step is skipped");
  // No serial mode: each adapter records its own result, so one adapter's failure must never
  // skip the others. The project already runs one worker, keeping the order.
  // Model picks, probes and a three-fetch agent task per adapter: 12 min each, so the four
  // adapters finish inside ~48 min and the job timeout still leaves room for teardown and
  // the report on every path.
  test.setTimeout(720_000);

  test.beforeAll(() => {
    if (!storageState || !fs.existsSync(storageState)) {
      const error = "the first run saved no session (OPA_STORAGE_STATE)";
      // The tests never run on this path, so record each adapter's failure here: the run
      // failed before any adapter could, and the report should say so per adapter.
      for (const adapter of ADAPTERS) record(fail(adapter, error));
      throw new Error(error);
    }
  });

  async function socketOpen(page: Page) {
    await page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/conversations" && res.ok(),
      { timeout: 60_000 },
    );
  }

  /** Adds the endpoint as a provider row for one wire API, with its own key binding. */
  async function addProvider(page: Page, adapter: Adapter, baseUrl: string, model: string) {
    const { status, json } = await api(page, "POST", "/api/settings/providers", {
      kind: "openai-chat",
      providerId: `live-${adapter}`,
      baseUrl,
      model,
      apiKey: API_KEY,
      api: adapter,
    });
    if (status !== 201 || !json || typeof json.id !== "string") {
      throw new Error(`adding the ${adapter} provider: HTTP ${status}`);
    }
    return { id: json.id as string, providerId: `live-${adapter}`, baseUrl };
  }

  /** The Test probe for one candidate model, without saving it. */
  async function probe(page: Page, rowId: string, model: string): Promise<TestResponse> {
    const { status, json } = await api(page, "POST", `/api/settings/providers/${rowId}/test`, {
      model,
    });
    if (status !== 200 || !json) throw new Error(`the Test probe: HTTP ${status}`);
    return json as unknown as TestResponse;
  }

  /**
   * Picks the adapter's model from the endpoint's own list (or the curated fallback when the
   * endpoint has no list call): the first one whose Test probe answers with tool calls,
   * priced where the price table knows it. The curated fallback is already task-capable-ordered,
   * so there the first pass wins outright — preferring its priced entry repeats the observed
   * failure (probe OK, artifact task never completes). At most four probes, so the adapter stays
   * inside its share of the live-step budget; the recorded error says how many models were tried
   * and why each probe failed, so a missing wire path (for example no `/responses` route) is
   * diagnosable from the report instead of reading as three model failures.
   */
  async function pickModel(page: Page, rowId: string, baseUrl: string, adapter: Adapter) {
    const { ids, curated } = await listModels(baseUrl, adapter);
    const candidates = ids.slice(0, 8);
    const tried = Math.min(4, candidates.length);
    const reasons: string[] = [];
    let fallback: { model: string; test: TestResponse } | null = null;
    for (const model of candidates.slice(0, 4)) {
      const probed = await probe(page, rowId, model);
      if (!probed.ok || !probed.tools || probed.toolProbe !== "called") {
        const why = !probed.ok
          ? (probed.error?.message ?? probed.error?.code ?? "probe failed")
          : `answered without tool calls (${probed.toolProbe})`;
        if (!reasons.includes(why)) reasons.push(why);
        continue;
      }
      if (curated || probed.price) return { model, test: probed };
      fallback ??= { model, test: probed };
    }
    if (!fallback) {
      const detail = reasons.length ? `; probe failures: ${reasons.join(" | ").slice(0, 200)}` : "";
      throw new Error(
        `no listed model passed the Test probe with tool calls (probed ${tried} of ${candidates.length} listed${detail})`,
      );
    }
    return fallback;
  }

  /** Runs the preflight-to-artifact flow for one adapter and records its result. */
  async function runAdapter(page: Page, adapter: Adapter): Promise<AdapterResult> {
    const result: AdapterResult = {
      adapter,
      model: null,
      testMs: null,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: null,
      expectedMicroUsd: null,
      cost: null,
      artifactId: null,
      artifactName: null,
      ok: false,
      error: null,
    };
    try {
      let rowId: string;
      let price: TestResponse["price"];
      if (adapter === "workers-ai-binding") {
        const starter = (await providerRows(page)).find((p) => p.kind === "workers-ai");
        if (!starter?.model) throw new Error("the starter provider is missing");
        rowId = starter.id;
        const probed = await probe(page, rowId, starter.model);
        if (!probed.ok) {
          throw new Error(`the Test probe failed: ${probed.error?.code ?? "unknown"}`);
        }
        if (!probed.tools || probed.toolProbe !== "called") {
          throw new Error("the Test probe answered without tool calls");
        }
        result.model = starter.model;
        result.testMs = probed.latencyMs ?? null;
        price = probed.price;
      } else {
        const baseUrl = adapter === "anthropic-messages" ? ANTHROPIC_BASE : OPENAI_BASE;
        if (!baseUrl) throw new Error("the adapter's base URL is not set");
        const added = await addProvider(page, adapter, baseUrl, "live-placeholder");
        rowId = added.id;
        const { model, test: probed } = await pickModel(page, rowId, baseUrl, adapter);
        // The edit keeps the endpoint and its key; only the model changes.
        const saved = await api(page, "PUT", `/api/settings/providers/${rowId}`, {
          kind: "openai-chat",
          providerId: added.providerId,
          baseUrl: added.baseUrl,
          model,
        });
        if (saved.status !== 200) throw new Error(`saving the model: HTTP ${saved.status}`);
        result.model = model;
        result.testMs = probed.latencyMs ?? null;
        price = probed.price;
      }
      const model = result.model;
      if (!model) throw new Error("no model was picked");
      const before = await usageByModel(page, model);
      const roles = await api(page, "PUT", "/api/settings/roles", {
        chat: { provider: rowId, model },
      });
      if (roles.status !== 200) throw new Error(`setting the Chat role: HTTP ${roles.status}`);

      const taskStart = Date.now();
      // New chat is local state only and fires no /api/conversations request: no wait here.
      await page.getByRole("button", { name: "New chat" }).click();
      await page
        .getByRole("textbox", { name: "Message" })
        .fill(
          `Fetch ${PAGES.join(", ")}. In one or two sentences each, say what each page is for, ` +
            `then save the three summaries as an artifact named live-check-${adapter}.md.`,
        );
      await page.getByRole("button", { name: "Send" }).click();
      const log = page.getByRole("log", { name: "Messages" });
      const deadline = Date.now() + 8 * 60_000;
      let artifact: ArtifactRow | null = null;
      for (;;) {
        if (await log.getByText("This reply failed").count()) {
          // The recorded row must say why the turn failed, not just that it did: carry
          // the visible log excerpt so a binding failure is diagnosable from the report.
          // The excerpt is model-generated text, so it goes through scrubKey first, and
          // it takes the tail: the failure notice sits at the end of the Messages log,
          // while the head is mostly our own prompt echo.
          const excerpt = (scrubKey((await log.textContent().catch(() => "")) ?? "") ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(-300);
          throw new Error(`the chat turn failed${excerpt ? `: ${excerpt}` : ""}`);
        }
        await decidePending(page).catch((error: unknown) => {
          throw new Error(`approving the task's tools: ${(error as Error).message}`);
        });
        artifact = await artifactSince(page, taskStart);
        if (artifact) break;
        if (Date.now() > deadline) {
          const excerpt = (scrubKey((await log.textContent().catch(() => "")) ?? "") ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(-300);
          throw new Error(`no artifact after 8 minutes${excerpt ? ` (log tail: ${excerpt})` : ""}`);
        }
        await page.waitForTimeout(5_000);
      }
      const content = await page.request.get(`/api/artifacts/${artifact.id}/content`);
      if (content.status() !== 200 || (await content.body()).length === 0) {
        throw new Error("the artifact has no content");
      }
      const after = await usageByModel(page, model);
      result.inputTokens = after.inputTokens - before.inputTokens;
      result.outputTokens = after.outputTokens - before.outputTokens;
      result.costMicroUsd = after.costMicroUsd - before.costMicroUsd;
      result.artifactId = artifact.id;
      result.artifactName = artifact.name;
      if (price) {
        result.expectedMicroUsd = Math.round(
          result.inputTokens * price.inputUsdPerMTok + result.outputTokens * price.outputUsdPerMTok,
        );
        const tolerance = Math.max(2, result.expectedMicroUsd * 0.05);
        result.cost =
          Math.abs(result.costMicroUsd - result.expectedMicroUsd) <= tolerance
            ? "match"
            : "mismatch";
        if (result.cost === "mismatch") {
          throw new Error(
            `cost ${result.costMicroUsd}uUSD against ${result.expectedMicroUsd}uUSD expected`,
          );
        }
      } else {
        result.cost = "unpriced";
      }
      result.ok = true;
    } catch (error) {
      Object.assign(result, fail(adapter, error), { model: result.model, testMs: result.testMs });
    }
    record(result);
    return result;
  }

  for (const adapter of [
    "workers-ai-binding",
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
  ] as const) {
    // The endpoint only has to serve the bases it was given: without one, its adapter keeps a
    // recorded result saying so instead of failing the others.
    test(`${adapter}: probe, task, artifact, cost`, async ({ page }) => {
      if (adapter === "anthropic-messages" && !ANTHROPIC_BASE) {
        record({ ...fail(adapter, "no LIVE_MODEL_ANTHROPIC_BASE_URL"), model: null });
      } else if (
        adapter !== "anthropic-messages" &&
        adapter !== "workers-ai-binding" &&
        !OPENAI_BASE
      ) {
        record({ ...fail(adapter, "no LIVE_MODEL_OPENAI_BASE_URL"), model: null });
      } else {
        try {
          // Start the conversation-load wait before navigation so a fast response is not missed.
          const conversationsOpen = socketOpen(page);
          await page.goto("/");
          await conversationsOpen;
        } catch (error) {
          // Navigation or the load wait can fail before runAdapter records a row. Record
          // that adapter's failure here so the report keeps a per-adapter row for it too.
          record(fail(adapter, error));
          throw error;
        }
        const result = await runAdapter(page, adapter);
        expect(result.ok, result.error ?? "the live run failed").toBe(true);
      }
    });
  }
});
