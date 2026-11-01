#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Serial driver for the owner-approved T3/T4/T7 cf-verify window (TWO-669, plan TWO-573).
// Subcommands: deploy, t3-sync, t3-wait-start, t4, t7, callback, collect, teardown. Live ones
// need CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the cf-verify environment); agents never
// hold them. $0 incremental: any cap or unverifiable allowance stops inconclusive (exit 3).
// Teardown deletes only manifest entries, then verifies nothing prefixed is left.
import { spawn } from "node:child_process";
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
  if (res.code !== 0) throw new Error(`fixture deploy failed:\n${redact(res.output, [])}`);
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
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
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
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    throw new Error(`no manifest for ${prefix}: refusing to guess what to delete`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
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

const LIVE = { deploy, collect, teardown };
export const HELP = "usage: cf-verify-t3t4t7.mjs <deploy|collect|teardown> --prefix <p>";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { prefix: { type: "string" } },
    allowPositionals: true,
  });
  const [command] = positionals;
  const deps = { env: process.env, run, stdout: (t) => process.stdout.write(t) };
  try {
    if (command in LIVE) {
      const prefix = values.prefix ?? "";
      if (!isCampaignPrefix(prefix)) throw new Error(`"${prefix}" is not a campaign prefix`);
      const out = await LIVE[command](prefix, deps);
      deps.stdout(`${command}: ${JSON.stringify(out ?? "ok")}\n`);
    } else {
      // Test phases (t3-sync, t3-wait-start, t4, t7, callback) land in the stacked follow-up;
      // each appends redacted JSONL observations for `collect`.
      deps.stdout(`${HELP}\n`);
      if (!command) process.exit(2);
      throw new Error(`unknown command "${command}"`);
    }
  } catch (error) {
    process.stderr.write(`\n✖ ${error instanceof Error ? error.message : error}\n`);
    process.exit(error instanceof Inconclusive ? 3 : 1);
  }
}
