#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Serial driver for the owner-approved T3/T4/T7 cf-verify window (TWO-669, plan TWO-573).
// Subcommands: deploy, t3-sync, t3-wait-start, t4, t7, callback, collect, teardown. Live ones
// need CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the cf-verify environment); agents never
// hold them. $0 incremental: any cap or unverifiable allowance stops inconclusive (exit 3).
// Teardown deletes only manifest entries, then verifies nothing prefixed is left.
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
export const STUB_TOOLS = ["lookupRecord", "add", "artifactRef"];

/**Deterministic synthetic corpus: 500 one-tool, 300 two-tool, 200 no-tool turns.*/
export function buildCorpus() {
  const turns = [];
  for (let i = 0; i < 500; i++) turns.push({ kind: "tool", id: `rec-${i % 50}`, a: i, b: i + 1 });
  for (let i = 0; i < 300; i++) turns.push({ kind: "two-tool", id: `rec-${i % 50}`, a: i, b: 2 });
  for (let i = 0; i < 200; i++) turns.push({ kind: "chat", fact: `synthetic fact ${i % 20}` });
  return turns;
}

/** Score one T7 turn: exact tool choice, schema-valid args and final result, no prose pass. */
export function scoreTurn(turn, emitted) {
  if (turn.kind === "chat") return emitted.length === 0 ? "pass" : "fail";
  const names = emitted.map((c) => c.name);
  if (turn.kind === "tool")
    return names.length === 1 && STUB_TOOLS.includes(names[0]) ? "pass" : "fail";
  return names.length === 2 && names.every((n) => STUB_TOOLS.includes(n)) ? "pass" : "fail";
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

function run(cmd, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function deploy(prefix, deps) {
  const config = fs.readFileSync(TEMPLATE, "utf8").replaceAll("__PREFIX__", prefix);
  const dir = path.join(ROOT, ".wrangler", "opa-t3t4t7", prefix);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wrangler.json");
  fs.writeFileSync(file, config);
  const env = { ...deps.env, CI: "1", WRANGLER_SEND_METRICS: "false" };
  const res = await deps.run(process.execPath, [WRANGLER, "deploy", "-c", file], {
    cwd: ROOT,
    env,
  });
  if (res.code !== 0)
    throw new Error(
      `fixture deploy failed:\n${redact(res.output, [deps.env.CLOUDFLARE_API_TOKEN])}`,
    );
  const api = accountApi(deps.env);
  const sub = await api(`/workers/subdomain`);
  const domain = sub.body.result?.subdomain;
  if (!domain) throw new Error("no workers.dev subdomain for the fixture URL");
  const url = `https://${prefix}-t3t4t7.${domain}.workers.dev`;
  const manifest = { prefix, url, workers: [`${prefix}-t3t4t7`], at: new Date().toISOString() };
  fs.mkdirSync(outDir(prefix), { recursive: true });
  fs.writeFileSync(
    path.join(outDir(prefix), "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function collect(prefix, deps) {
  const dir = outDir(prefix);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { workers: [`${prefix}-t3t4t7 (manifest missing: prefix fallback)`] };
  const secrets = [deps.env.CLOUDFLARE_API_TOKEN];
  for (const test of ["t3", "t4", "t7"]) {
    const obs = path.join(dir, `${test}.jsonl`);
    const lines = fs.existsSync(obs) ? fs.readFileSync(obs, "utf8") : "";
    const body = [
      `# ${prefix} ${test.toUpperCase()} evidence (redacted)`,
      ``,
      `- collected: ${new Date().toISOString()}`,
      `- fixture: ${manifest.workers.join(", ")}`,
      `- commit: ${deps.env.GITHUB_SHA ?? "local run"}`,
      ``,
      "```json",
      redact(lines || "(no observations: inconclusive)", secrets),
      "```",
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(dir, `${test}-evidence.md`), body);
  }
  return dir;
}

async function teardown(prefix, deps) {
  const dir = outDir(prefix);
  const manifestFile = path.join(dir, "manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { workers: [], fallback: "no manifest: scoped-prefix delete, never account-wide" };
  await teardownCloudflare(["--name", prefix, "--confirm", prefix], {
    env: deps.env,
    fetch,
    stdout: (t) => deps.stdout(redact(t, [deps.env.CLOUDFLARE_API_TOKEN])),
  });
  const api = accountApi(deps.env);
  const { found } = await listPrefixed(api, prefix);
  const manifestNames = new Set(manifest.workers);
  const left = found.filter((r) => manifestNames.has(r.name) || r.name.startsWith(`${prefix}-`));
  if (left.length) throw new Error(`teardown left: ${left.map((r) => r.name).join(", ")}`);
  return { deleted: manifest.workers };
}

function manifestOf(prefix) {
  return JSON.parse(fs.readFileSync(path.join(outDir(prefix), "manifest.json"), "utf8"));
}

function note(prefix, test, row) {
  fs.mkdirSync(outDir(prefix), { recursive: true });
  fs.appendFileSync(path.join(outDir(prefix), `${test}.jsonl`), `${JSON.stringify(row)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(url, method, body, secrets) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${redact(url, secrets)}: HTTP ${res.status}`);
  return data;
}

/** T3 sync cases: duplicate-ID creates (2 sequential + 2 concurrent of ≤8), cancel, offload ref. */
async function t3sync(prefix, deps) {
  const { url } = manifestOf(prefix);
  const secrets = [deps.env.CLOUDFLARE_API_TOKEN];
  const id = `${prefix}-t3-brief`;
  const mk = () =>
    call(`${url}/t3/instance`, "POST", { id, kind: "briefing" }, secrets).then(
      (r) => ({ ok: true, id: r.id }),
      (e) => ({ ok: false, error: redact(e.message, secrets) }),
    );
  const attempts = [await mk(), await mk(), ...(await Promise.all([mk(), mk()]))];
  note(prefix, "t3", { case: "dedupe", at: new Date().toISOString(), attempts });
  let status = {};
  for (let i = 0; i < 60; i++) {
    status = await call(`${url}/t3/status?id=${id}`, "GET", undefined, secrets);
    if (status.status === "complete" || status.status === "error") break;
    await sleep(5000);
  }
  const ledger = await call(`${url}/t3/ledger?instance=${id}`, "GET", undefined, secrets);
  const briefing = ledger.effects.filter((e) => e.step === "briefing");
  note(prefix, "t3", { case: "briefing-done", status, effects: ledger.effects.length });
  const cid = `${prefix}-t3-cancel`;
  await call(`${url}/t3/instance`, "POST", { id: cid, kind: "cancel" }, secrets);
  await sleep(15000);
  await call(`${url}/t3/terminate`, "POST", { id: cid }, secrets);
  const late = await call(
    `${url}/t3/event`,
    "POST",
    { id: cid, name: "late-event", payload: "x" },
    secrets,
  ).then(
    (r) => ({ sent: r.sent }),
    (e) => ({ sent: false, note: redact(e.message, secrets) }),
  );
  const after = await call(`${url}/t3/ledger?instance=${cid}`, "GET", undefined, secrets);
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
  const { url } = manifestOf(prefix);
  const secrets = [deps.env.CLOUDFLARE_API_TOKEN];
  const id = `${prefix}-t3-wait`;
  await call(`${url}/t3/instance`, "POST", { id, kind: "wait" }, secrets);
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
  const { url } = manifestOf(prefix);
  const secrets = [deps.env.CLOUDFLARE_API_TOKEN];
  const wait = JSON.parse(fs.readFileSync(path.join(outDir(prefix), "wait.json"), "utf8"));
  if (!waitReady(wait.startUtc, Date.now()))
    throw new Error(`T3 wait: callback before ${wait.earliestCallbackUtc}`);
  const sentAt = Date.now();
  await call(
    `${url}/t3/event`,
    "POST",
    { id: wait.id, name: "approval", payload: "synthetic-approval" },
    secrets,
  );
  let status = {};
  for (let i = 0; i < 60; i++) {
    status = await call(`${url}/t3/status?id=${wait.id}`, "GET", undefined, secrets);
    if (status.status === "complete" || status.status === "error") break;
    await sleep(5000);
  }
  const ledger = await call(`${url}/t3/ledger?instance=${wait.id}`, "GET", undefined, secrets);
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

function openSocket(url, stream, since) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${url.replace(/^http/, "ws")}/t4/socket?stream=${stream}&since=${since}`,
    );
    const received = [];
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
  const { url } = manifestOf(prefix);
  const secrets = [deps.env.CLOUDFLARE_API_TOKEN];
  const sync = async () => {
    const log = await call(`${url}/t4/log?stream=${prefix}-t4`, "GET", undefined, secrets);
    return log.events.length;
  };
  const tabs = [];
  for (let t = 0; t < BOUNDS.t4.sockets; t++) tabs.push(await openSocket(url, `${prefix}-t4`, -1));
  note(prefix, "t4", { phase: "connected", at: new Date().toISOString() });
  await sleep(10 * 60_000);
  const reconnect = async (tab, at) => {
    const started = Date.now();
    tab.ws.close();
    const since = Math.max(-1, ...tab.received);
    const fresh = await openSocket(url, `${prefix}-t4`, since);
    tabs[at] = { ...fresh, received: [...tab.received, ...fresh.received] };
    const ms = Date.now() - started;
    note(prefix, "t4", { phase: "reconnect", tab: at, catchupMs: ms });
    if (ms > 10_000) throw new Error(`T4: tab ${at} catch-up took ${ms} ms (>10 s)`);
  };
  for (let m = 0; m < 20; m++) {
    tabs[m % 3].ws.send(JSON.stringify({ chat: `synthetic-${m}` }));
    if (m === 9) await reconnect(tabs[0], 0);
    if (m === 14) for (let t = 0; t < 3; t++) await reconnect(tabs[t], t);
    await sleep(2 * 60_000);
  }
  await sleep(10 * 60_000);
  const total = await sync();
  const full = Array.from({ length: total }, (_, i) => i);
  const missing = tabs.map((t) => full.filter((s) => !t.received.includes(s)));
  for (const t of tabs) t.ws.close();
  note(prefix, "t4", {
    phase: "done",
    total,
    missing,
    metering: "unverified: isolated DO GB-s deltas need an operator read",
  });
  if (missing.some((m) => m.length)) throw new Error("T4: a tab missed or duplicated events");
  return { total };
}

const STUB_SCHEMAS = STUB_TOOLS.map((name) => ({
  function: { name, parameters: { type: "object" } },
}));

/** T7: 20-turn stratified pilot now; the corpus waits on verified neuron headroom (plan §stop). */
async function t7run(prefix, deps, { model }) {
  if (!model) throw new Error("t7 needs --model (the pinned starter under test)");
  const { url } = manifestOf(prefix);
  const secrets = [deps.env.CLOUDFLARE_API_TOKEN];
  const corpus = buildCorpus();
  const kinds = (k, n) => corpus.filter((t) => t.kind === k).slice(0, n);
  const pilot = [...kinds("tool", 8), ...kinds("two-tool", 8), ...kinds("chat", 4)];
  let pass = 0;
  for (const turn of pilot) {
    const started = Date.now();
    const prompt =
      turn.kind === "chat" ? `Say: ${turn.fact}` : `Use the stub tools for ${JSON.stringify(turn)}`;
    if (prompt.length > BOUNDS.t7.inTokens * 4)
      throw new OverBudget("T7: prompt over the per-turn budget");
    const res = await call(
      `${url}/t7/turn`,
      "POST",
      { model, messages: [{ role: "user", content: prompt }], tools: STUB_SCHEMAS },
      secrets,
    );
    const emitted = res.raw?.tool_calls ?? res.raw?.response?.tool_calls ?? [];
    const verdict = scoreTurn(turn, emitted);
    if (verdict === "pass") pass++;
    note(prefix, "t7", {
      kind: turn.kind,
      verdict,
      latencyMs: Date.now() - started,
      rejected400: false,
    });
  }
  note(prefix, "t7", { phase: "pilot-done", pass, of: pilot.length });
  throw new Inconclusive(
    "T7 pilot complete; corpus paused: neuron headroom is unverifiable with the campaign " +
      "permission set (no analytics scope), so the 1,000-turn target must wait for an authorized read",
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
  "usage: cf-verify-t3t4t7.mjs <deploy|t3-sync|t3-wait-start|t4|t7 --model M|callback|collect|teardown> --prefix <p>";

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
      if (command === "deploy" && !prefix) prefix = newCampaignPrefix(new Date(), randomBytes);
      if (!isCampaignPrefix(prefix)) throw new Error(`"${prefix}" is not a campaign prefix`);
      const out = await LIVE[command](prefix, deps, { model: values.model });
      // Actions logs are public: the workers.dev subdomain never reaches them.
      deps.stdout(
        `${command}: ${redact(JSON.stringify(out ?? "ok"), [deps.env.CLOUDFLARE_API_TOKEN])}\n`,
      );
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
