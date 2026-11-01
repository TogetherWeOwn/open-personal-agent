#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm deploy:cloudflare [--name <prefix>] [--dry-run]`: ADR 0001 steps 0–9. Every step is
// idempotent, so a re-run is the upgrade path. Secret values live only in this process and on
// wrangler's stdin, never in argv, files or logs; the setup link goes to the terminal only.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const SECRET_NAMES = ["OPA_MASTER_KEY", "OPA_SESSION_SECRET", "OPA_SETUP_TOKEN"];
// Leaves room for the `-task-workflow` suffix inside Cloudflare's 64-character name limit.
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const API = "https://api.cloudflare.com/client/v4";
const DASH = "https://dash.cloudflare.com";
const COST_LINE =
  "Cost: Workers Paid is required ($5/month baseline). Usage above the included amounts is " +
  "metered; Workers AI, storage and Containers are billed separately.";

export class DeployError extends Error {}

export function defaultDeps() {
  return {
    env: process.env,
    root: ROOT,
    nodeVersion: process.versions.node,
    fetch: globalThis.fetch,
    randomBytes,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (text) => process.stdout.write(text),
    tty: openTerminal,
    run: runProcess,
  };
}

/** Runs a child with piped stdio, so wrangler never prompts. Only `stdout` is parsed as JSON. */
function runProcess(cmd, args, { cwd, env, input, onOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: "pipe" });
    let output = "";
    let stdout = "";
    const collect = (chunk) => {
      output += chunk;
      onOutput?.(String(chunk));
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      collect(chunk);
    });
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output, stdout }));
    child.stdin.end(input ?? "");
  });
}

/** The setup link goes only to an interactive terminal, never to CI logs or redirected output. */
function openTerminal(env) {
  return env.CI || !process.stdout.isTTY ? null : (text) => process.stdout.write(text);
}

// JSONC comments and trailing commas; group 1 keeps string literals intact.
const JSONC_NOISE = /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g;
const parseJsonc = (text) => JSON.parse(text.replace(JSONC_NOISE, (_m, s) => s ?? ""));

// The deploy config for one prefix, under `.wrangler/` (gitignored). Workflow names are
// account-wide, so they take the prefix too. wrangler's ID write-back never reaches wrangler.jsonc.
function writeDeployConfig(root, name) {
  const config = parseJsonc(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
  const dir = path.join(root, ".wrangler", "opa-deploy", name);
  const rel = (p) => path.relative(dir, path.join(root, p));
  const prefixed = (n) => `${name}-${n.replace(/^opa-/, "")}`;
  delete config.$schema;
  config.name = name;
  config.main = rel(config.main);
  if (config.assets?.directory) config.assets.directory = rel(config.assets.directory);
  for (const db of config.d1_databases ?? []) {
    if (db.migrations_dir) db.migrations_dir = rel(db.migrations_dir);
  }
  for (const wf of config.workflows ?? []) wf.name = prefixed(wf.name);
  for (const ex of Object.values(config.exports ?? {})) {
    if (ex.type === "workflow" && ex.name) ex.name = prefixed(ex.name);
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wrangler.json");
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return { file, dir };
}

/** Hashes the deploy inputs (skipping the bundle README, which holds a timestamp). */
function fingerprint(root, paths) {
  const hash = createHash("sha256");
  const walk = (p) => {
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      for (const entry of fs.readdirSync(p).sort()) walk(path.join(p, entry));
    } else if (stat && path.basename(p) !== "README.md") {
      hash.update(path.relative(root, p)).update(fs.readFileSync(p));
    }
  };
  for (const p of paths) walk(p);
  return `opa-${hash.digest("hex").slice(0, 16)}`;
}

export async function deployCloudflare(argv, deps = defaultDeps()) {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  // Every value in `secrets` is scrubbed from anything this script prints.
  const secrets = new Set();
  const scrub = (text) => [...secrets].reduce((t, s) => t.replaceAll(s, "[redacted]"), text);
  const log = (line = "") => deps.stdout(`${scrub(line)}\n`);
  const name = values.name ?? deps.env.OPA_PREFIX ?? "opa";
  const dryRun = values["dry-run"];
  if (!NAME_PATTERN.test(name)) {
    throw new DeployError(`invalid name "${name}": use 1–48 lowercase letters, digits or dashes`);
  }
  const permissions = JSON.parse(
    fs.readFileSync(path.join(deps.root, "deploy", "permissions.json"), "utf8"),
  ).permissions;
  const describe = (p) =>
    `missing permission "${p.group}" (${p.scope}), needed for ${p.neededFor}; ` +
    `see deploy/permissions.json entry "${p.id}"`;

  const childEnv = { ...deps.env, CI: "1" };
  const exec = async (cmd, args, { input, quiet = false, step } = {}) => {
    // Scrub whole lines only, so a value split across output chunks is still caught.
    let pending = "";
    const print = (chunk) => {
      pending += chunk;
      const end = pending.lastIndexOf("\n") + 1;
      if (end) deps.stdout(scrub(pending.slice(0, end)));
      pending = pending.slice(end);
    };
    const onOutput = quiet ? undefined : print;
    const result = await deps.run(cmd, args, { cwd: deps.root, env: childEnv, input, onOutput });
    if (pending) deps.stdout(scrub(pending));
    if (result.code !== 0 && step) {
      const text = result.output;
      const hint = permissions.filter((p) => p.steps?.includes(step)).map(describe);
      if (hint.length && /\b403\b|code: 10000|Authentication error/i.test(text)) {
        throw new DeployError(`step "${step}" was refused (403). Likely:\n  ${hint.join("\n  ")}`);
      }
      if (/workers paid|paid plan|upgrade your plan/i.test(text)) {
        throw new DeployError(
          `Workers Paid ($5/month) is required: ${DASH}/?to=/:account/workers/plans`,
        );
      }
      throw new DeployError(`${step} failed (exit ${result.code}); see the output above`);
    }
    return result;
  };
  const wrangler = (args, options) => exec(process.execPath, [WRANGLER, ...args], options);

  // Step 0: preflight.
  log(`Deploying "${name}"${dryRun ? " (dry run: nothing on Cloudflare changes)" : ""}`);
  const [major, minor] = deps.nodeVersion.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new DeployError(`Node.js 22.12 or newer is required (found ${deps.nodeVersion})`);
  }
  const auth = await wrangler(["auth", "token", "--json"], { quiet: true });
  const credentials = auth.code === 0 ? JSON.parse(auth.stdout) : null;
  if (credentials?.type === "api_key")
    throw new DeployError("use CLOUDFLARE_API_TOKEN, not an API key");
  if (!credentials && !dryRun) {
    throw new DeployError("not logged in: run `pnpm wrangler login` or set CLOUDFLARE_API_TOKEN");
  }
  if (!credentials) log("No Cloudflare credentials: skipping the account checks.");
  const token = credentials?.token;
  if (token) secrets.add(token);
  const apiBase = deps.env.CLOUDFLARE_API_BASE_URL ?? API;
  const api = async (p) => {
    const res = await deps.fetch(`${apiBase}${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && body.success !== false, body };
  };

  let accountId = deps.env.CLOUDFLARE_ACCOUNT_ID;
  let url = null;
  if (token) {
    if (!accountId) {
      const res = await api("/accounts?per_page=50");
      const accounts = res.ok ? res.body.result : [];
      if (accounts.length !== 1)
        throw new DeployError(`set CLOUDFLARE_ACCOUNT_ID (${accounts.length} found)`);
      accountId = accounts[0].id;
    }
    childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
    if (credentials.type === "api_token") {
      let verify = await api("/user/tokens/verify");
      if (!verify.ok) verify = await api(`/accounts/${accountId}/tokens/verify`);
      if (!verify.ok || verify.body.result?.status !== "active") {
        throw new DeployError("CLOUDFLARE_API_TOKEN is invalid, expired or not active");
      }
    }
    // Steps 0 and 2: one cheap read per permission, and the R2-enabled check.
    const missing = [];
    for (const p of permissions.filter((entry) => entry.required && entry.check)) {
      const res = await api(p.check.replace("{account_id}", accountId));
      if (res.body.errors?.some((e) => e.code === 10042)) {
        throw new DeployError(`R2 is not enabled: enable it at ${DASH}/${accountId}/r2/overview`);
      }
      if (res.status === 401 || res.status === 403) missing.push(describe(p));
      else if (!res.ok) throw new DeployError(`preflight read ${p.id} failed (HTTP ${res.status})`);
    }
    if (missing.length)
      throw new DeployError(`the token is not enough:\n  ${missing.join("\n  ")}`);
    // Step 3: a brand-new account has no workers.dev subdomain, and wrangler would prompt for one.
    const sub = await api(`/accounts/${accountId}/workers/subdomain`);
    if (!sub.ok || !sub.body.result?.subdomain) {
      throw new DeployError(
        `no workers.dev subdomain: register one at ${DASH}/${accountId}/workers`,
      );
    }
    url = `https://${name}.${sub.body.result.subdomain}.workers.dev`;
    log("Preflight passed: token, permissions, R2 and workers.dev.");
  }

  // Step 4: build and bundle. The fingerprint becomes the version tag of the deploy.
  await exec("pnpm", ["build"], { step: "build" });
  const config = writeDeployConfig(deps.root, name);
  const bundle = path.join(config.dir, "bundle");
  fs.rmSync(bundle, { recursive: true, force: true });
  await wrangler(["deploy", "--dry-run", "--outdir", bundle, "-c", config.file], { step: "build" });
  const inputs = [config.file, bundle, "apps/web/dist", "migrations"];
  const tag = fingerprint(
    deps.root,
    inputs.map((p) => path.resolve(deps.root, p)),
  );

  // Steps 1 and 5: provision and deploy, unless the active version already carries this tag.
  const changed = [];
  const current = token ? await deployedTag(api, accountId, name) : null;
  if (current === tag) log("Worker: up to date.");
  else if (dryRun) log(`Worker: would deploy version ${tag}.`);
  else {
    await wrangler(["deploy", "-c", config.file, "--tag", tag], { step: "deploy" });
    changed.push("worker");
  }

  // Step 6: migrations. wrangler confirms by itself when stdin is not a terminal.
  if (dryRun) log("Migrations: would apply any that are pending.");
  else {
    const res = await wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", config.file], {
      step: "migrations",
    });
    if (!res.output.includes("No migrations to apply")) changed.push("migrations");
  }

  // Step 7: generate only the missing secrets. An existing OPA_MASTER_KEY is never replaced.
  let existing = [];
  if (!dryRun) {
    const res = await wrangler(["secret", "list", "--format", "json", "-c", config.file], {
      quiet: true,
      step: "secrets",
    });
    existing = JSON.parse(res.stdout).map((s) => s.name);
  }
  const generated = {};
  for (const secret of SECRET_NAMES.filter((n) => !existing.includes(n))) {
    generated[secret] = deps.randomBytes(32).toString("base64");
    secrets.add(generated[secret]);
  }
  const names = Object.keys(generated);
  if (names.length && dryRun)
    log(`Secrets: would set ${names.join(", ")} (values generated, then discarded).`);
  else if (names.length) {
    await wrangler(["secret", "bulk", "-c", config.file], {
      input: JSON.stringify(generated),
      step: "secrets",
    });
    log(`Secrets: set ${names.join(", ")}.`);
    changed.push("secrets");
  }
  // Shown before the health wait, so a slow first boot can't lose the only copy.
  if (generated.OPA_SETUP_TOKEN && url && !dryRun) {
    const terminal = deps.tty(deps.env);
    if (terminal) {
      terminal(
        `One-time setup link (shown once, opens /setup): ${url}/setup#token=${generated.OPA_SETUP_TOKEN}\n`,
      );
    } else {
      log(`No terminal, so no setup link. Set a new token with \`pnpm wrangler secret put`);
      log(`OPA_SETUP_TOKEN --name ${name}\`, then open ${url}/setup#token=<that value>.`);
    }
  }

  // Step 8: wait for /api/health.
  if (url && !dryRun) {
    let healthy = false;
    for (let i = 0; i < 20 && !healthy; i++) {
      const res = await deps.fetch(`${url}/api/health`).catch(() => null);
      healthy = res?.status === 200;
      if (!healthy) await deps.sleep(3000);
    }
    if (!healthy) throw new DeployError(`${url}/api/health did not answer 200 within 60 s`);
  }

  // Step 9: report.
  log();
  log(
    dryRun
      ? "Dry run finished."
      : changed.length
        ? `Deployed: ${changed.join(", ")}.`
        : "Up to date: nothing changed.",
  );
  if (url) log(`URL: ${url}`);
  log(COST_LINE);
  return { name, tag, changed, dryRun, url };
}

// The newest version tag, if the active version is that one or was reached from it only through
// deployed secret changes (step 7). Undeployed drafts don't count. History is newest first, so a
// page that doesn't reach the tagged version can't rule out drift.
async function deployedTag(api, accountId, name) {
  const base = `/accounts/${accountId}/workers/scripts/${name}`;
  const deployments = await api(`${base}/deployments`);
  if (deployments.status === 404) return null;
  const history = deployments.body.result?.deployments ?? [];
  const deployed = new Set(history.flatMap((d) => d.versions.map((v) => v.version_id)));
  const active = history[0]?.versions ?? [];
  const versions = (await api(`${base}/versions`)).body.result?.items ?? [];
  versions.sort((a, b) => b.number - a.number);
  const tagged = versions.find((v) => v.annotations?.["workers/tag"]);
  const running = versions.filter((v) => active.some((a) => a.version_id === v.id));
  if (!tagged || running.length !== 1 || !deployed.has(tagged.id)) return null;
  const [lo, hi] = [tagged.number, running[0].number];
  const since = versions.filter((v) => deployed.has(v.id) && v.number > lo && v.number <= hi);
  const drift = hi < lo || since.some((v) => v.annotations?.["workers/triggered_by"] !== "secret");
  return drift ? null : tagged.annotations["workers/tag"];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  deployCloudflare(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`\n✖ ${error instanceof DeployError ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
