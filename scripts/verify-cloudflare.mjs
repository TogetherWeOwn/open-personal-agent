#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm verify:cloudflare [--name <prefix>] [--report <file>]` (deploy/VERIFY.md): under a
// throwaway `opa-v-<date>-<rand>` prefix, a fresh deploy, the first run in a browser (claim with a
// virtual passkey, onboard, a first answer from Workers AI), a re-run that must be up to date, an
// upgrade with a dummy migration, health and smoke, then teardown, which runs even after a failure.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DeployError, defaultDeps, deployCloudflare } from "./deploy-cloudflare.mjs";
import { inventory, PREFIX_PATTERN, teardownCloudflare } from "./teardown-cloudflare.mjs";

// Actions logs are public, so the account's workers.dev subdomain never reaches them.
const SUBDOMAIN = /(https:\/\/[a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev/g;
const hide = (text) => text.replace(SUBDOMAIN, "$1.<subdomain>.workers.dev");
// What wrangler prints when it answers a prompt by itself in a non-interactive run.
const PROMPT = /fallback value in non-interactive context/gi;
const SETUP_LINK = /\/setup#token=(\S+)/;
// PRD F-2.1 AC1 (a fresh deploy) and A-O1 (from the deploy to a first answer), in minutes.
const BUDGET = { deploy: 10, prompts: 3, firstAnswer: 15 };

export function newPrefix(date, randomBytes) {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `opa-v-${day}-${[...randomBytes(6)].map((b) => (b % 36).toString(36)).join("")}`;
}

/** Hides the setup token, raw and as the claim URL carries it. */
export function maskToken(text, token) {
  return [encodeURIComponent(token), token].reduce(
    (t, v) => t.replaceAll(v, "<setup token>"),
    text,
  );
}

/** test/first-run in Playwright on the deployment. The setup token reaches it only in its env. */
async function firstRun(url, setupToken, deps) {
  const cli = path.join(deps.root, "node_modules", "@playwright", "test", "cli.js");
  const res = await deps.run(
    process.execPath,
    [cli, "test", "--project", "first-run", "--reporter", "line", "--trace", "off"],
    {
      cwd: deps.root,
      env: { ...deps.env, BASE_URL: url, OPA_SETUP_TOKEN: setupToken },
      onOutput: (text) => deps.stdout(maskToken(text, setupToken)),
    },
  );
  if (res.code !== 0) throw new DeployError(`the first run in the browser failed (${res.code})`);
}

const STEPS = { deploy: deployCloudflare, teardown: teardownCloudflare, inventory, firstRun };

export async function verifyCloudflare(argv, deps = defaultDeps(), steps = STEPS) {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: "string" }, report: { type: "string" } },
  });
  const prefix = values.name ?? newPrefix(new Date(), deps.randomBytes);
  if (!PREFIX_PATTERN.test(prefix)) throw new DeployError(`"${prefix}" is not opa-v-<date>-<rand>`);
  let prompts = 0;
  let setupToken = null;
  const vdeps = {
    ...deps,
    // The setup link stays in this process: only the first run in the browser uses it.
    tty: () => (text) => {
      setupToken = text.match(SETUP_LINK)?.[1] ?? setupToken;
    },
    stdout: (text) => {
      prompts += text.match(PROMPT)?.length ?? 0;
      deps.stdout(hide(text));
    },
  };
  const phases = [];
  const phase = async (label, fn) => {
    const row = { label, result: "fail", start: Date.now() };
    phases.push(row);
    try {
      const value = await fn();
      row.result = "pass";
      return value;
    } finally {
      row.seconds = (Date.now() - row.start) / 1000;
    }
  };
  const deploy = (label, expect) =>
    phase(label, async () => {
      const result = await steps.deploy(["--name", prefix], vdeps);
      const { changed } = result;
      if (expect.some((c) => !changed.includes(c)) || (!expect.length && changed.length)) {
        throw new DeployError(`${label}: expected [${expect}], changed [${result.changed}]`);
      }
      return result;
    });
  // Open item: without IDs in the config, does every re-deploy re-bind the same D1 and R2?
  const snapshots = [];
  const snapshot = async (label) => {
    const found = await steps.inventory(vdeps, prefix);
    const ids = (kind) => found.filter((r) => r.kind === kind).map((r) => r.item.uuid ?? r.name);
    snapshots.push({ label, d1: ids("d1"), r2: ids("r2") });
  };

  let failure = null;
  let migration = null;
  const metrics = {};
  try {
    const start = Date.now();
    const { url } = await deploy("Fresh deploy", ["worker", "migrations", "secrets"]);
    metrics.deploy = { minutes: (Date.now() - start) / 60_000, prompts };
    await snapshot("after the fresh deploy");
    await phase("Claim, onboard, first answer", async () => {
      if (!setupToken) throw new DeployError("the fresh deploy printed no setup link");
      await steps.firstRun(url, setupToken, vdeps);
    });
    metrics.firstAnswer = { minutes: (Date.now() - start) / 60_000 };
    await deploy("Re-run (up to date)", []);
    await snapshot("after the re-run");
    migration = writeDummyMigration(deps.root);
    await deploy("Upgrade (dummy migration)", ["worker", "migrations"]);
    await snapshot("after the upgrade");
    const one = (s) => s.d1.length === 1 && s.r2.length === 1 && `${s.d1} ${s.r2}`;
    const same = (s) => one(s) && one(s) === one(snapshots[0]);
    if (!snapshots.every(same)) throw new DeployError("a re-deploy did not re-bind the same D1/R2");
    await phase("Health and smoke", () => smoke(deps.fetch, url));
    // Over budget fails the run, after the remaining phases so the report still has them.
    const missed = missedBudgets(metrics);
    if (missed.length) throw new DeployError(`over budget: ${missed.join(", ")}`);
  } catch (error) {
    failure = error;
  } finally {
    if (migration) fs.rmSync(migration.file, { force: true });
  }
  const args = ["--name", prefix, "--confirm", prefix];
  const teardown = await phase("Teardown", () => steps.teardown(args, vdeps)).catch((error) => {
    failure ??= error;
    return null;
  });

  const report = renderReport(deps, {
    ...{ prefix, failure, phases, prompts, snapshots, teardown, metrics },
  });
  const file = values.report ?? path.join(deps.root, ".wrangler", "opa-verify", `${prefix}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, report.replace("{{migration}}", migration?.name ?? "(not reached)"));
  deps.stdout(`\n${fs.readFileSync(file, "utf8")}\nReport: ${file}\n`);
  if (failure) {
    // The caller prints the error to the same public log.
    failure.message = hide(failure.message);
    if (failure.stack) failure.stack = hide(failure.stack);
    throw failure;
  }
  return { prefix, report: file };
}

/** Numbered after the last migration, so it always applies last. Deleted after the run. */
function writeDummyMigration(root) {
  const numbers = fs.readdirSync(path.join(root, "migrations")).map((f) => Number.parseInt(f, 10));
  const next = Math.max(-1, ...numbers.filter((n) => n >= 0)) + 1;
  const name = `${String(next).padStart(4, "0")}_verify_upgrade.sql`;
  const file = path.join(root, "migrations", name);
  fs.writeFileSync(file, "-- verify:cloudflare\nCREATE TABLE verify_upgrade (id integer);\n");
  return { name, file };
}

async function smoke(fetch, url) {
  const health = await fetch(`${url}/api/health`);
  const body = await health.json().catch(() => ({}));
  if (body.status !== "ok") throw new DeployError(`/api/health: ${health.status} ${body.status}`);
  const home = await fetch(`${url}/`);
  if (home.status !== 200) throw new DeployError(`GET /: HTTP ${home.status}`);
}

function missedBudgets({ deploy, firstAnswer }) {
  return [
    deploy.minutes > BUDGET.deploy && `fresh deploy took ${deploy.minutes.toFixed(1)} min`,
    deploy.prompts > BUDGET.prompts && `fresh deploy needed ${deploy.prompts} prompts`,
    firstAnswer.minutes > BUDGET.firstAnswer &&
      `first answer took ${firstAnswer.minutes.toFixed(1)} min`,
  ].filter(Boolean);
}

function budgets({ deploy, firstAnswer }) {
  const met = (ok) => (ok ? "met" : "**not met**");
  const min = (m) => `${m.toFixed(1)} min`;
  return [
    deploy
      ? `| F-2.1 AC1: fresh deploy | ≤ ${BUDGET.deploy} min, ≤ ${BUDGET.prompts} prompts | ` +
        `${min(deploy.minutes)}, ${deploy.prompts} prompts | ` +
        `${met(deploy.minutes <= BUDGET.deploy && deploy.prompts <= BUDGET.prompts)} |`
      : `| F-2.1 AC1: fresh deploy | ≤ ${BUDGET.deploy} min, ≤ ${BUDGET.prompts} prompts | not reached | **not met** |`,
    firstAnswer
      ? `| A-O1: deploy to a first answer | ≤ ${BUDGET.firstAnswer} min | ${min(firstAnswer.minutes)} | ` +
        `${met(firstAnswer.minutes <= BUDGET.firstAnswer)} |`
      : `| A-O1: deploy to a first answer | ≤ ${BUDGET.firstAnswer} min | not reached | **not met** |`,
  ].join("\n");
}

function renderReport(deps, r) {
  const file = (p) => fs.readFileSync(path.join(deps.root, "deploy", p), "utf8");
  const outcome = (p) => {
    if (r.failure?.message.includes(`entry "${p.id}"`)) return "**missing: the run needed it**";
    if (p.required) return "in the token";
    return r.failure
      ? "not in the token; not proven (the run failed)"
      : "not in the token, not needed";
  };
  const t = r.teardown;
  const fill = {
    prefix: r.prefix,
    date: new Date().toISOString(),
    commit: deps.env.GITHUB_SHA ?? "local run",
    result: r.failure ? `**FAIL**: ${hide(r.failure.message)}` : "**PASS**",
    prompts: String(r.prompts),
    phases: r.phases
      .map((p) => `| ${p.label} | ${p.seconds.toFixed(1)} s | ${p.result} |`)
      .join("\n"),
    total: r.phases.reduce((sum, p) => sum + p.seconds, 0).toFixed(1),
    permissions: JSON.parse(file("permissions.json"))
      .permissions.map((p) => `| \`${p.id}\` | ${p.group} | ${outcome(p)} |`)
      .join("\n"),
    budgets: budgets(r.metrics),
    rebinding: r.snapshots.map((s) => `| ${s.label} | ${s.d1} | ${s.r2} |`).join("\n"),
    teardown: t
      ? `Deleted ${t.deleted.length} (${t.deleted.join("; ")}); 0 left.` +
        (t.skipped.length ? ` Not listable with this token: ${t.skipped}.` : "")
      : "**Did not finish.** Clean up with `pnpm teardown:cloudflare` (deploy/VERIFY.md §3).",
  };
  return file("verify-report.md").replace(/\{\{(\w+)\}\}/g, (m, key) => fill[key] ?? m);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  verifyCloudflare(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`\n✖ ${error instanceof DeployError ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
