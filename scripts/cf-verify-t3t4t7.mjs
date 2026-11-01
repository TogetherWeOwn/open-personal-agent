#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Serial driver for the owner-approved T3/T4/T7 cf-verify window (TWO-669, plan TWO-573).
// Subcommands: deploy, t3-sync, t3-wait-start, t4, t7, callback, collect, teardown. Live ones
// need CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and CF_VERIFY_BEARER (the cf-verify
// environment); agents never hold them. $0 incremental: any cap or unverifiable allowance
// stops inconclusive (exit 3). Teardown deletes only manifest entries, then verifies nothing
// prefixed is left. The full workers.dev URL is rebuilt at runtime per command and never
// written to disk or logs: the manifest carries only the worker name.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { listPrefixed, PREFIX_PATTERN, teardownCloudflare } from "./teardown-cloudflare.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const TEMPLATE = path.join(ROOT, "cf-verify", "t3t4t7", "wrangler.jsonc");

/** Campaign prefix: `opa-v-q4-<UTC yyyymmdd>-<8hex>`. The legacy M2 form stays teardownable. */
export const CAMPAIGN_PATTERN = /^opa-v-q4-[0-9]{8}-[0-9a-f]{8}$/;
export const isCampaignPrefix = (name) => CAMPAIGN_PATTERN.test(name) || PREFIX_PATTERN.test(name);

export function newCampaignPrefix(date, randomBytes) {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `opa-v-q4-${day}-${[...randomBytes(4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Scrub tokens, keys and the account's workers.dev subdomain from anything recorded. */
export function redact(text, secrets) {
  let out = String(text).replace(
    /(https:\/\/[a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev/g,
    "$1.<subdomain>.workers.dev",
  );
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, "[redacted]");
  return out;
}

export class Inconclusive extends Error {}
export class OverBudget extends Error {}

// Plan bounds: never exceed, never silently shrink (T7 keeps its 1,000-turn target).
export const BOUNDS = {
  t3: { instances: 10, steps: 100, bytes: 10 * 1024 * 1024, requests: 2000 },
  t4: { sockets: 3, minutes: 60, messages: 500, requests: 2000 },
  t7: {
    turns: 1000,
    pilot: 20,
    neuronsPerDay: 8000,
    callsPerTurn: 4,
    inTokens: 2048,
    outTokens: 512,
  },
};
/** Real JSON schemas with descriptions, so the model knows which stub fits each turn. */
export const TOOL_SCHEMAS = {
  lookupRecord: {
    description: "Look up a synthetic record by id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Record id, e.g. rec-3." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  add: {
    description: "Add two numbers.",
    parameters: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  artifactRef: {
    description: "Return a reference to a synthetic artifact by tag.",
    parameters: {
      type: "object",
      properties: { tag: { type: "string", description: "Artifact tag." } },
      required: ["tag"],
      additionalProperties: false,
    },
  },
};
export const STUB_TOOLS = Object.keys(TOOL_SCHEMAS);
export const STUB_SCHEMA_LIST = STUB_TOOLS.map((name) => ({
  // `type: "function"`: without it OpenAI-format models may not return tool calls at all.
  type: "function",
  function: {
    name,
    description: TOOL_SCHEMAS[name].description,
    parameters: TOOL_SCHEMAS[name].parameters,
  },
}));

/**
 * Both tool-call response shapes Workers AI models return, in one place. Mirror of
 * normalizeToolCalls in cf-verify/t3t4t7/worker.ts (kept in sync by hand: the worker
 * bundles independently, so it cannot import this file).
 */
export function normalizeToolCalls(raw) {
  const nested = raw?.choices?.[0]?.message?.tool_calls;
  const list = Array.isArray(nested) && nested.length ? nested : (raw?.tool_calls ?? []);
  return list.map((c) => {
    const fn = c?.function ?? c;
    return { name: fn?.name ?? "", arguments: fn?.arguments };
  });
}

/** A Workers AI cap/limit failure: the fixture answers 429 `ai-capacity`, and `call`
 * surfaces it as `error.status`/`error.body`. Match only those — never the message, which
 * carries the fixture URL with the campaign's 8-hex prefix (a prefix containing `429`
 * would turn any HTTP error into inconclusive). */
export function isCapacityError(error) {
  if (error?.status === 429) return true;
  return error?.body?.error === "ai-capacity";
}

/**
 * Mirror of the fixture's runStub: the expected result for expected args. Throws on
 * schema-invalid args, so a scoring bug in the corpus surfaces instead of passing quietly.
 */
export function stubResult(name, args) {
  const a = typeof args === "string" ? JSON.parse(args) : args;
  if (name === "lookupRecord") {
    if (typeof a?.id !== "string") throw new Error("lookupRecord needs a string id");
    return { id: a.id, value: 41 };
  }
  if (name === "add") {
    if (typeof a?.a !== "number" || typeof a?.b !== "number")
      throw new Error("add needs numeric a and b");
    return { sum: a.a + a.b };
  }
  if (name === "artifactRef") {
    if (typeof a?.tag !== "string") throw new Error("artifactRef needs a string tag");
    return { ref: `synthetic:${a.tag}` };
  }
  throw new Error(`not-a-stub: ${name}`);
}

/** Deterministic synthetic corpus: 500 one-tool, 300 ordered two-tool, 200 no-tool turns. */
export function buildCorpus() {
  const turns = [];
  for (let i = 0; i < 500; i++) {
    const name = STUB_TOOLS[i % STUB_TOOLS.length];
    const args =
      name === "lookupRecord"
        ? { id: `rec-${i % 50}` }
        : name === "add"
          ? { a: i, b: i + 1 }
          : { tag: `tag-${i % 20}` };
    turns.push({
      kind: "tool",
      prompt: `Use ${name} with ${JSON.stringify(args)}.`,
      expect: [{ name, args }],
    });
  }
  for (let i = 0; i < 300; i++) {
    const first = { name: "lookupRecord", args: { id: `rec-${i % 50}` } };
    const second =
      i % 2
        ? { name: "artifactRef", args: { tag: `tag-${i % 20}` } }
        : { name: "add", args: { a: i, b: 2 } };
    turns.push({
      kind: "two-tool",
      prompt: `Use ${first.name} then ${second.name} with ${JSON.stringify({ first: first.args, second: second.args })}.`,
      expect: [first, second],
    });
  }
  for (let i = 0; i < 200; i++)
    turns.push({ kind: "chat", prompt: `Say: synthetic fact ${i % 20}.`, expect: [] });
  return turns;
}

export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
  );
}

/**
 * Score one T7 turn: the exact expected tool sequence in order, schema-valid args that
 * deep-equal the expected args, and stub results matching the expected computation. A model
 * that always calls `add` fails every non-add turn; prose with no calls passes only chat.
 */
export function scoreTurn(turn, emitted, executions = []) {
  if (turn.kind === "chat") return emitted.length === 0 ? "pass" : "fail";
  if (emitted.length !== turn.expect.length) return "fail";
  const ok = turn.expect.every((exp, i) => {
    if (emitted[i]?.name !== exp.name) return false;
    let args;
    try {
      args =
        typeof emitted[i].arguments === "string"
          ? JSON.parse(emitted[i].arguments)
          : emitted[i].arguments;
    } catch {
      return false;
    }
    if (!deepEqual(args, exp.args)) return false;
    const exec = executions[i];
    if (!exec || exec.name !== exp.name || "error" in exec) return false;
    let expected;
    try {
      expected = stubResult(exp.name, exp.args);
    } catch {
      return false;
    }
    return deepEqual(exec.result, expected);
  });
  return ok ? "pass" : "fail";
}

/** Per-tab seq coverage: duplicate delivery on replay is the bug T4 must catch. */
export function checkTabCoverage(total, received) {
  const counts = new Map();
  for (const s of received) counts.set(s, (counts.get(s) ?? 0) + 1);
  const missing = [];
  const duplicated = [];
  for (let s = 0; s < total; s++) {
    const count = counts.get(s) ?? 0;
    if (count === 0) missing.push(s);
    else if (count > 1) duplicated.push(s);
  }
  return { missing, duplicated };
}

function outDir(prefix) {
  const base = process.env.RUNNER_TEMP ?? path.join(ROOT, ".wrangler", "opa-t3t4t7");
  return path.join(base, prefix);
}

function accountApi(env) {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = env;
  if (!token || !account)
    throw new Inconclusive("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  const base = "https://api.cloudflare.com/client/v4";
  return async (p, init = {}) => {
    const res = await fetch(`${base}/accounts/${account}${p}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && body.success !== false, body };
  };
}

function run(cmd, args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/** Bearer plus every secret the redactor must scrub from recorded output. */
function authOf(env) {
  if (!env.CF_VERIFY_BEARER)
    throw new Error(
      "CF_VERIFY_BEARER is not set (operator: add it once to the cf-verify environment)",
    );
  return {
    secrets: [env.CLOUDFLARE_API_TOKEN, env.CF_VERIFY_BEARER],
    bearer: env.CF_VERIFY_BEARER,
  };
}

/**
 * Whatever secrets exist for redaction. Teardown and collect must work without the bearer
 * (teardown-only is the recovery path): they scrub what they have and never require it.
 */
function secretsOf(env) {
  return [env.CLOUDFLARE_API_TOKEN, env.CF_VERIFY_BEARER].filter(Boolean);
}

function manifestOf(prefix) {
  return JSON.parse(fs.readFileSync(path.join(outDir(prefix), "manifest.json"), "utf8"));
}

/**
 * The full fixture URL, rebuilt at runtime from the stored worker name plus the live
 * subdomain. Never persisted: the manifest on disk and in artifacts carries no subdomain.
 */
async function fixtureUrl(prefix, deps) {
  const manifest = manifestOf(prefix);
  const api = accountApi(deps.env);
  const sub = await api(`/workers/subdomain`);
  const domain = sub.body.result?.subdomain;
  if (!domain) throw new Error("no workers.dev subdomain for the fixture URL");
  return `https://${manifest.worker}.${domain}.workers.dev`;
}

/**
 * The generated per-campaign config. The template's relative `main` would resolve under the
 * generated config's directory (`.wrangler/opa-t3t4t7/<prefix>/`), where no worker exists —
 * so substitute the absolute fixture entrypoint.
 */
export function renderDeployConfig(prefix, model) {
  return fs
    .readFileSync(TEMPLATE, "utf8")
    .replaceAll("__PREFIX__", prefix)
    .replaceAll("__T7_MODEL__", model)
    .replace(
      '"main": "worker.ts"',
      `"main": ${JSON.stringify(path.join(ROOT, "cf-verify", "t3t4t7", "worker.ts"))}`,
    );
}

async function deploy(prefix, deps, { model }) {
  if (!model) throw new Error("deploy needs --model (the pinned starter under test)");
  if (/["\\\n\r]/.test(model)) throw new Error("deploy: --model is not JSON-safe");
  const { secrets, bearer } = authOf(deps.env);
  const config = renderDeployConfig(prefix, model);
  const dir = path.join(ROOT, ".wrangler", "opa-t3t4t7", prefix);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wrangler.json");
  fs.writeFileSync(file, config);
  const env = { ...deps.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
  const res = await deps.run(process.execPath, [WRANGLER, "deploy", "-c", file], {
    cwd: ROOT,
    env,
  });
  if (res.code !== 0) throw new Error(`fixture deploy failed:\n${redact(res.output, secrets)}`);
  // After deploy: the fixture fails closed (401) until this secret lands, so the gap is safe.
  const put = await deps.run(
    process.execPath,
    [WRANGLER, "secret", "put", "CF_VERIFY_BEARER", "-c", file],
    { cwd: ROOT, env, input: bearer },
  );
  if (put.code !== 0) throw new Error(`bearer secret put failed:\n${redact(put.output, secrets)}`);
  // No `url` here: artifacts are public to signed-in users, and the URL embeds the subdomain.
  const manifest = {
    prefix,
    worker: `${prefix}-t3t4t7`,
    model,
    at: new Date().toISOString(),
  };
  fs.mkdirSync(outDir(prefix), { recursive: true });
  fs.writeFileSync(
    path.join(outDir(prefix), "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function collect(prefix, deps) {
  const dir = outDir(prefix);
  fs.mkdirSync(dir, { recursive: true });
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { worker: `${prefix}-t3t4t7 (manifest missing: prefix fallback)` };
  const secrets = secretsOf(deps.env);
  for (const test of ["t3", "t4", "t7"]) {
    const obs = path.join(dir, `${test}.jsonl`);
    const lines = fs.existsSync(obs) ? fs.readFileSync(obs, "utf8") : "";
    const body = [
      `# ${prefix} ${test.toUpperCase()} evidence (redacted)`,
      ``,
      `- collected: ${new Date().toISOString()}`,
      `- fixture: ${manifest.worker}`,
      `- model: ${manifest.model ?? "unknown"}`,
      `- commit: ${deps.env.GITHUB_SHA ?? "local run"}`,
      ``,
      "```json",
      redact(lines || "(no observations: inconclusive)", secrets),
      "```",
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(dir, `${test}-evidence.md`), body);
  }
  // Per-step exit outcomes, written by the workflow after each phase. A T3 assumption failure
  // is a legitimate result: later phases still run, and the bundle says which failed.
  const stepsFile = path.join(dir, "steps.txt");
  const steps = fs.existsSync(stepsFile) ? fs.readFileSync(stepsFile, "utf8") : "";
  fs.writeFileSync(
    path.join(dir, "steps.md"),
    [
      `# ${prefix} step outcomes`,
      ``,
      `- collected: ${new Date().toISOString()}`,
      ``,
      "```",
      redact(steps.trim() || "(no step outcomes recorded)", secrets),
      "```",
      ``,
    ].join("\n"),
  );
  return dir;
}

export async function teardown(prefix, deps) {
  const dir = outDir(prefix);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { workers: [], fallback: "no manifest: scoped-prefix delete, never account-wide" };
  const secrets = secretsOf(deps.env);
  await teardownCloudflare(["--name", prefix, "--confirm", prefix], {
    env: deps.env,
    fetch,
    stdout: (t) => deps.stdout(redact(t, secrets)),
  });
  const api = accountApi(deps.env);
  const { found } = await listPrefixed(api, prefix);
  const manifestNames = new Set(manifest.workers ?? (manifest.worker ? [manifest.worker] : []));
  const left = found.filter((r) => manifestNames.has(r.name) || r.name.startsWith(`${prefix}-`));
  if (left.length) throw new Error(`teardown left: ${left.map((r) => r.name).join(", ")}`);
  return { deleted: [...manifestNames] };
}

function note(prefix, test, row) {
  fs.mkdirSync(outDir(prefix), { recursive: true });
  fs.appendFileSync(path.join(outDir(prefix), `${test}.jsonl`), `${JSON.stringify(row)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(url, method, body, { secrets, bearer }) {
  if (!bearer)
    throw new Error(
      "CF_VERIFY_BEARER is not set (operator: add it once to the cf-verify environment)",
    );
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(`${method} ${redact(url, secrets)}: HTTP ${res.status}`);
    error.status = res.status;
    error.body = data;
    throw error;
  }
  return data;
}

/** T3 sync cases: duplicate-ID creates (2 sequential + 2 concurrent of ≤8), cancel, offload ref. */
async function t3sync(prefix, deps) {
  const url = await fixtureUrl(prefix, deps);
  const { secrets, bearer } = authOf(deps.env);
  const auth = { secrets, bearer };
  const id = `${prefix}-t3-brief`;
  const mk = () =>
    call(`${url}/t3/instance`, "POST", { id, kind: "briefing" }, auth).then(
      (r) => ({ ok: true, id: r.id }),
      (e) => ({ ok: false, error: redact(e.message, secrets) }),
    );
  const attempts = [await mk(), await mk(), ...(await Promise.all([mk(), mk()]))];
  note(prefix, "t3", { case: "dedupe", at: new Date().toISOString(), attempts });
  let status = {};
  for (let i = 0; i < 60; i++) {
    status = await call(`${url}/t3/status?id=${id}`, "GET", undefined, auth);
    if (status.status === "complete" || status.status === "error") break;
    await sleep(5000);
  }
  const ledger = await call(`${url}/t3/ledger?instance=${id}`, "GET", undefined, auth);
  const briefing = ledger.effects.filter((e) => e.step === "briefing");
  note(prefix, "t3", { case: "briefing-done", status, effects: ledger.effects.length });
  const cid = `${prefix}-t3-cancel`;
  await call(`${url}/t3/instance`, "POST", { id: cid, kind: "cancel" }, auth);
  await sleep(15000);
  await call(`${url}/t3/terminate`, "POST", { id: cid }, auth);
  const late = await call(
    `${url}/t3/event`,
    "POST",
    { id: cid, name: "late-event", payload: "x" },
    auth,
  ).then(
    (r) => ({ sent: r.sent }),
    (e) => ({ sent: false, note: redact(e.message, secrets) }),
  );
  const after = await call(`${url}/t3/ledger?instance=${cid}`, "GET", undefined, auth);
  const steps = after.effects.map((e) => e.step);
  note(prefix, "t3", { case: "cancel", late, steps });
  const ok =
    briefing.length === 1 &&
    status.output?.ref?.endsWith("/large.bin") &&
    !steps.includes("cancel-step-2");
  if (!ok)
    throw new Error("T3 sync: dedupe, offload-ref or cancel assumption failed (see t3.jsonl)");
  return { attempts: attempts.length, effects: ledger.effects.length };
}

/** T3 wait case: start the real ≥25 h wait; the +25 h callback is a separate operator dispatch. */
async function t3waitstart(prefix, deps) {
  const url = await fixtureUrl(prefix, deps);
  const { secrets, bearer } = authOf(deps.env);
  const auth = { secrets, bearer };
  const id = `${prefix}-t3-wait`;
  await call(`${url}/t3/instance`, "POST", { id, kind: "wait" }, auth);
  const startUtc = new Date().toISOString();
  const wait = {
    id,
    startUtc,
    earliestCallbackUtc: new Date(Date.now() + 25 * 3600_000).toISOString(),
  };
  fs.writeFileSync(path.join(outDir(prefix), "wait.json"), `${JSON.stringify(wait, null, 2)}\n`);
  note(prefix, "t3", { case: "wait-started", ...wait });
  return wait;
}

/** The +25 h gate, pure for tests. */
export function waitReady(startUtc, nowMs) {
  return nowMs - Date.parse(startUtc) >= 25 * 3600_000;
}

async function callback(prefix, deps) {
  const url = await fixtureUrl(prefix, deps);
  const { secrets, bearer } = authOf(deps.env);
  const auth = { secrets, bearer };
  const wait = JSON.parse(fs.readFileSync(path.join(outDir(prefix), "wait.json"), "utf8"));
  if (!waitReady(wait.startUtc, Date.now()))
    throw new Error(`T3 wait: callback before ${wait.earliestCallbackUtc}`);
  const sentAt = Date.now();
  await call(
    `${url}/t3/event`,
    "POST",
    { id: wait.id, name: "approval", payload: "synthetic-approval" },
    auth,
  );
  let status = {};
  for (let i = 0; i < 60; i++) {
    status = await call(`${url}/t3/status?id=${wait.id}`, "GET", undefined, auth);
    if (status.status === "complete" || status.status === "error") break;
    await sleep(5000);
  }
  const ledger = await call(`${url}/t3/ledger?instance=${wait.id}`, "GET", undefined, auth);
  const elapsedH = (Date.now() - Date.parse(wait.startUtc)) / 3600_000;
  const ok = status.status === "complete" && (Date.now() - sentAt) / 60_000 <= 5;
  note(prefix, "t3", {
    case: "wait-callback",
    elapsedH: +elapsedH.toFixed(2),
    status,
    ledger: ledger.effects,
  });
  if (!ok) throw new Error("T3 wait: completion missing or slower than 5 min after the event");
  return { elapsedH: +elapsedH.toFixed(2) };
}

/**
 * Open a T4 tab socket. Live events push into `received`: pass the tab's existing array on
 * reconnect, so the merged history stays live. A fresh array would go stale — the new
 * socket's listener owns the array it was given, and a copy made at reconnect time never
 * sees another event.
 */
export function openSocket(url, stream, since, bearer, received = []) {
  return new Promise((resolve, reject) => {
    // Undici's WebSocket cannot set headers, so the bearer travels as a query param the
    // fixture accepts on this route only. It lives in memory here, never on disk or in logs.
    const ws = new WebSocket(
      `${url.replace(/^http/, "ws")}/t4/socket?stream=${stream}&since=${since}&bearer=${encodeURIComponent(bearer)}`,
    );
    const timer = setTimeout(() => reject(new Error("socket open timeout")), 15000);
    ws.addEventListener("message", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (typeof data.seq === "number") received.push(data.seq);
        if (data.hello) {
          clearTimeout(timer);
          resolve({ ws, received });
        }
      } catch {
        /* non-JSON noise is recorded by the close dump */
      }
    });
    ws.addEventListener("error", (e) => reject(e));
  });
}

/** T4: three tabs on one DO for a real hour; reconnect at min 30 (one tab) and 45 (all). */
async function t4run(prefix, deps) {
  const url = await fixtureUrl(prefix, deps);
  const { secrets, bearer } = authOf(deps.env);
  const auth = { secrets, bearer };
  const sync = async () => {
    const log = await call(`${url}/t4/log?stream=${prefix}-t4`, "GET", undefined, auth);
    return log.events.length;
  };
  const tabs = [];
  for (let t = 0; t < BOUNDS.t4.sockets; t++)
    tabs.push(await openSocket(url, `${prefix}-t4`, -1, bearer));
  note(prefix, "t4", { phase: "connected", at: new Date().toISOString() });
  await sleep(10 * 60_000);
  const reconnect = async (tab, at) => {
    const started = Date.now();
    tab.ws.close();
    const since = tab.received.length ? Math.max(...tab.received) : -1;
    // The replay (seqs after `since`) appends to the tab's own array, which stays the live
    // target for the new socket's listener — and keeps `since` correct for later reconnects.
    const fresh = await openSocket(url, `${prefix}-t4`, since, bearer, tab.received);
    tabs[at] = fresh;
    const ms = Date.now() - started;
    note(prefix, "t4", { phase: "reconnect", tab: at, catchupMs: ms });
    if (ms > 10_000) throw new Error(`T4: tab ${at} catch-up took ${ms} ms (>10 s)`);
  };
  // The plan's minutes 30 and 45 are 20 and 35 minutes into the active period (after
  // the opening 10 idle minutes): trigger on elapsed time, not the message index.
  const activeStart = Date.now();
  const reconnected = { one: false, all: false };
  for (let m = 0; m < 20; m++) {
    tabs[m % 3].ws.send(JSON.stringify({ chat: `synthetic-${m}` }));
    const elapsed = Date.now() - activeStart;
    if (!reconnected.one && elapsed >= 20 * 60_000) {
      await reconnect(tabs[0], 0);
      reconnected.one = true;
    }
    if (!reconnected.all && elapsed >= 35 * 60_000) {
      for (let t = 0; t < 3; t++) await reconnect(tabs[t], t);
      reconnected.all = true;
    }
    await sleep(2 * 60_000);
  }
  await sleep(10 * 60_000);
  const total = await sync();
  const coverage = tabs.map((t) => checkTabCoverage(total, t.received));
  for (const t of tabs) t.ws.close();
  note(prefix, "t4", {
    phase: "done",
    total,
    coverage,
    metering: "unverified: isolated DO GB-s deltas need an operator read",
  });
  // The plan expects all 20 chats in the server log: a lost chat must fail, not pass.
  if (total !== 20) throw new Error(`T4: server logged ${total} chats, expected 20`);
  if (coverage.some((c) => c.missing.length || c.duplicated.length))
    throw new Error("T4: a tab missed or duplicated events");
  return { total };
}

/** T7: 20-turn stratified pilot now; the corpus waits on verified neuron headroom (plan §stop). */
async function t7run(prefix, deps, { model }) {
  if (!model) throw new Error("t7 needs --model (the pinned starter under test)");
  const url = await fixtureUrl(prefix, deps);
  const { secrets, bearer } = authOf(deps.env);
  const auth = { secrets, bearer };
  const corpus = buildCorpus();
  const kinds = (k, n) => corpus.filter((t) => t.kind === k).slice(0, n);
  const pilot = [...kinds("tool", 8), ...kinds("two-tool", 8), ...kinds("chat", 4)];
  let pass = 0;
  for (const turn of pilot) {
    const started = Date.now();
    if (turn.prompt.length > BOUNDS.t7.inTokens * 4)
      throw new OverBudget("T7: prompt over the per-turn budget");
    // A 400 here is a driver bug (wrong model, oversized prompt, non-stub tool): the fixture
    // only executes allowlisted stubs with the model's own arguments, so model misbehavior
    // arrives as 200 with errored executions and scores a fail, never a crash. A 429 or
    // capacity error is a cap: the whole window stops inconclusive, per the plan.
    let res;
    try {
      res = await call(
        `${url}/t7/turn`,
        "POST",
        { model, messages: [{ role: "user", content: turn.prompt }], tools: STUB_SCHEMA_LIST },
        auth,
      );
    } catch (error) {
      if (isCapacityError(error))
        throw new Inconclusive(
          `T7: Workers AI cap or limit (${error.message}): stopping inconclusive`,
        );
      throw error;
    }
    // Score the fixture's normalized list — the same calls it executed — not the raw shape.
    const emitted = res.calls ?? normalizeToolCalls(res.raw ?? {});
    const verdict = scoreTurn(turn, emitted, res.executions ?? []);
    if (verdict === "pass") pass++;
    note(
      prefix,
      "t7",
      verdict === "pass"
        ? { kind: turn.kind, verdict, latencyMs: Date.now() - started }
        : {
            kind: turn.kind,
            verdict,
            latencyMs: Date.now() - started,
            expected: turn.expect.map((e) => e.name),
            emitted: emitted.map((c) => c?.name),
          },
    );
  }
  note(prefix, "t7", { phase: "pilot-done", pass, of: pilot.length });
  throw new Inconclusive(
    "T7 pilot complete with no reservation: neuron headroom is unverifiable with the campaign " +
      "permission set (no analytics scope), so the 20-turn pilot runs without one and the " +
      "1,000-turn corpus stays paused per the plan's stop rules",
  );
}

const LIVE = {
  deploy,
  collect,
  teardown,
  "t3-sync": t3sync,
  "t3-wait-start": t3waitstart,
  t4: t4run,
  t7: t7run,
  callback,
};
export const HELP =
  "usage: cf-verify-t3t4t7.mjs <deploy --model M|t3-sync|t3-wait-start|t4|t7 --model M|callback|collect|teardown> --prefix <p>";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { prefix: { type: "string" }, model: { type: "string" } },
    allowPositionals: true,
  });
  const [command] = positionals;
  const deps = { env: process.env, run, stdout: (t) => process.stdout.write(t) };
  try {
    if (command in LIVE) {
      let prefix = values.prefix ?? "";
      if (command === "deploy" && !prefix) {
        prefix = newCampaignPrefix(new Date(), randomBytes);
        // The prefix is not secret (it names public artifacts); print it before the first
        // deploy call so a failed `secret put` never leaves a Worker up under an unseen prefix.
        deps.stdout(`prefix: ${prefix}\n`);
      }
      if (!isCampaignPrefix(prefix)) throw new Error(`"${prefix}" is not a campaign prefix`);
      const out = await LIVE[command](prefix, deps, { model: values.model });
      // Actions logs are public: the workers.dev subdomain and the bearer never reach them.
      // Teardown and collect run bearer-less, so only scrub the secrets that exist.
      const secrets = secretsOf(deps.env);
      deps.stdout(`${command}: ${redact(JSON.stringify(out ?? "ok"), secrets)}\n`);
    } else {
      deps.stdout(`${HELP}\n`);
      if (!command) process.exit(2);
      throw new Error(`unknown command "${command}"`);
    }
  } catch (error) {
    process.stderr.write(`\n✖ ${error instanceof Error ? error.message : error}\n`);
    process.exit(error instanceof Inconclusive ? 3 : 1);
  }
}
