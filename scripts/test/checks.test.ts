// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findDependencyViolations, findPortViolations } from "../check-boundaries.mjs";
import { findViolations } from "../check-builder-independence.mjs";
import { checkBudget, findLeakedNames, serverOnlyNames } from "../check-bundles.mjs";
import { bindingNames, checkDocsCost } from "../check-docs-cost.mjs";
import {
  bundledPackages,
  checkPnpmPolicy,
  checkRenovatePolicy,
  checkRuntimeDependencies,
  checkWorkflow,
} from "../check-supply-chain.mjs";
import { disallowed, flatten } from "../generate-notices.mjs";
import { parseJsonc } from "../lib/repo.mjs";

// Denylisted words are assembled at runtime so this file passes its own scan.
const join = (...parts: string[]) => parts.join("");
const file = (path: string, text: string) => [{ path, text }];
const denied = (path: string, text: string) => findViolations(file(path, text)).length;
const ports = (path: string, text: string) => findPortViolations(file(path, text)).length;

describe("builder independence", () => {
  it("flags denylisted imports, URLs, env names and paths", () => {
    const text = [
      `import { x } from "@${join("paper", "clip")}ai/sdk";`,
      `const url = "https://${join("cli", "proxy")}.example/v1";`,
      `process.env.${join("HIND", "SIGHT")}_URL;`,
      `import "@anthropic-ai/${join("claude", "-code")}";`,
      `process.env.${join("CLAUDE_", "CODE_")}OAUTH_TOKEN;`,
    ].join("\n");
    expect(denied("apps/worker/src/x.ts", text)).toBe(5);
    expect(denied(`docs/${join("Paper", "clip")}.md`, "")).toBe(1);
    expect(denied("apps/worker/src/a.ts", 'import { Hono } from "hono";')).toBe(0);
  });
});

describe("boundaries", () => {
  it("rejects runtime modules in packages and the web app only", () => {
    for (const spec of ["cloudflare:workers", "node:fs", "fs/promises", "agents", "agents/mcp"]) {
      const text = `import x from "${spec}";`;
      expect(ports("packages/core/src/a.ts", text)).toBe(1);
      expect(ports("apps/web/src/a.tsx", text)).toBe(1);
      expect(ports("apps/worker/src/a.ts", text)).toBe(0);
      expect(ports("packages/core/test/a.test.ts", text)).toBe(0);
    }
    expect(ports("packages/db/src/a.ts", 'await import("node:crypto")')).toBe(1);
    expect(
      findPortViolations(file("packages/db/src/a.ts", 'x;\nawait import(\n  "node:fs"\n)')),
    ).toEqual(['packages/db/src/a.ts:2: imports "node:fs" (ports rule, ADR 0011 #4)']);
    expect(ports("packages/db/src/a.ts", 'import { z } from "zod";')).toBe(0);
  });

  it("applies to the Worker modules @opa/worker exports to apps/node", () => {
    const worker = (app: string) => [
      { path: "apps/worker/package.json", text: '{ "exports": { "./app": "./src/app.ts" } }' },
      { path: "apps/worker/src/app.ts", text: app },
      {
        path: "apps/worker/src/chat/index.tsx",
        text: 'import { DurableObject } from "cloudflare:workers";',
      },
      { path: "apps/worker/src/index.ts", text: 'import { env } from "cloudflare:workers";' },
    ];
    expect(findPortViolations(worker('import { chat } from "./chat";'))).toEqual([
      'apps/worker/src/chat/index.tsx:1: imports "cloudflare:workers" (ports rule, ADR 0011 #4)',
    ]);
    expect(findPortViolations(worker('import type { Chat } from "./chat";'))).toEqual([]);
    // Types from a runtime module are erased too; a runtime import after them keeps its line.
    const typed =
      'import type {\n  DurableObjectState,\n} from "cloudflare:workers";\nimport "node:fs";';
    expect(findPortViolations(worker(typed))).toEqual([
      'apps/worker/src/app.ts:4: imports "node:fs" (ports rule, ADR 0011 #4)',
    ]);
  });

  it("rejects tooling in dependencies but allows it in devDependencies", () => {
    const text = JSON.stringify({
      dependencies: { hono: "1", vitest: "1", "@types/node": "1", "drizzle-kit": "1" },
      devDependencies: { wrangler: "1" },
    });
    expect(findDependencyViolations(file("package.json", text))).toHaveLength(3);
  });
});

describe("supply chain", () => {
  it("checks the pnpm and Renovate policies", () => {
    const yaml =
      "onlyBuiltDependencies:\n  - esbuild\nminimumReleaseAge: 1440\nstrictDepBuilds: true";
    expect(checkPnpmPolicy(yaml)).toEqual([]);
    const lax = yaml.replace("esbuild", "esbuild\n  - sharp").replace("1440", "60");
    expect(checkPnpmPolicy(lax.replace("strictDepBuilds: true", ""))).toHaveLength(3);
    expect(checkRenovatePolicy('{"minimumReleaseAge":"3 days"}')).toEqual([]);
    expect(checkRenovatePolicy("{}")).toHaveLength(1);
  });

  it("requires SHA pins, read-only permissions and no privileged PR trigger", () => {
    const wf = (job: string) => `on: push\npermissions:\n  contents: read\njobs:\n  a:\n${job}`;
    const step = (uses: string) => wf(`    steps:\n      - uses: ${uses}\n`);
    expect(checkWorkflow("ci.yml", step(`a/b@${"a".repeat(40)} # v1`))).toEqual([]);
    expect(checkWorkflow("ci.yml", step("./.github/actions/setup"))).toEqual([]);
    expect(checkWorkflow("ci.yml", step("actions/checkout@v7"))).toEqual([
      'ci.yml: jobs.a.steps.0 uses "actions/checkout@v7", which is not pinned to a full SHA',
    ]);
    expect(checkWorkflow("ci.yml", step(">-\n          actions/checkout@v7"))).toHaveLength(1);
    expect(
      checkWorkflow("ci.yml", wf("    uses: o/r/.github/workflows/x.yml@main\n")),
    ).toHaveLength(1);
    const extra = wf("    steps: []\n").replace("read\n", "read\n  actions: read\n");
    expect(checkWorkflow("ci.yml", extra)).toEqual([
      'ci.yml: top-level permissions must be exactly "contents: read"',
    ]);
    const jobWrite = wf(
      "    permissions:\n      contents: read # never write\n\n      actions: write\n",
    );
    expect(checkWorkflow("ci.yml", jobWrite)).toEqual(['ci.yml: job "a" grants write']);
    expect(checkWorkflow("ci.yml", wf("    permissions: write-all\n"))).toHaveLength(1);
    expect(checkWorkflow("ci.yml", wf("    permissions: { contents: read } # no write\n"))).toEqual(
      [],
    );
    const trigger = join("pull_request", "_target");
    expect(
      checkWorkflow("ci.yml", `on: [push, ${trigger}]\npermissions:\n  contents: read\n`),
    ).toEqual(["ci.yml: uses pull_request_target"]);
  });

  it("lists the packages in the Worker bundle and flags unreviewed ones", () => {
    const pnpm = "node_modules/.pnpm";
    const meta = JSON.stringify({
      inputs: {
        "apps/worker/src/index.ts": {},
        "packages/db/src/repository.ts": {},
        "node-built-in-modules:path": {},
        [`${pnpm}/hono@4.0.0/node_modules/hono/dist/index.js`]: {},
        [`${pnpm}/agents@0.32.0_vite@8.0.0/node_modules/agents/dist/index.js`]: {},
        [`${pnpm}/@scope+pkg@1.0.0/node_modules/@scope/pkg/index.js`]: {},
        "../outside/evil.js": {},
      },
    });
    expect(bundledPackages(meta)).toEqual(["../outside/evil.js", "@scope/pkg", "agents", "hono"]);
    expect(checkRuntimeDependencies(meta)).toHaveLength(2);
    expect(checkRuntimeDependencies(meta)[1]).toContain('"@scope/pkg"');
  });

  it("doesn't count a build-only peer the bundle doesn't contain", () => {
    // agents' lockfile snapshot lists vite as a dependency; esbuild never bundles it.
    const meta = JSON.stringify({
      inputs: { "node_modules/.pnpm/agents@0.32.0_vite@8.0.0/node_modules/agents/x.js": {} },
    });
    expect(bundledPackages(meta)).toEqual(["agents"]);
    expect(checkRuntimeDependencies(meta)).toEqual([]);
  });

  it("fails when the metafile is missing", () => {
    expect(checkRuntimeDependencies(null)).toEqual([
      "dist/worker-meta.json: missing, so the Worker's bundled packages can't be checked; " +
        "run `pnpm deploy:dry-run` first",
    ]);
  });
});

describe("bundles", () => {
  it("finds server-only names and enforces budgets", () => {
    const names = serverOnlyNames("# comment\nOPA_MASTER_KEY=\n");
    expect(names).toEqual(["OPA_MASTER_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
    expect(findLeakedNames(file("a.js", "env.OPA_MASTER_KEY"), names)).toHaveLength(1);
    expect(checkBudget("web", 100, 100)).toEqual([]);
    expect(checkBudget("web", 101, 100)).toEqual(["web is over its budget"]);
  });
});

describe("notices", () => {
  it("lists each package version and rejects disallowed licences", () => {
    const packages = flatten({
      MIT: [{ name: "hono", versions: ["4.0.0"], paths: ["/x/hono"], license: "MIT" }],
      "AGPL-3.0": [{ name: "bad", versions: ["1.0.0"], paths: ["/x/bad"], license: "AGPL-3.0" }],
    });
    expect(packages.map((p: { id: string }) => p.id)).toEqual(["bad@1.0.0", "hono@4.0.0"]);
    expect(disallowed(packages)).toEqual(['bad@1.0.0: licence "AGPL-3.0" is not allowed']);
  });
});

describe("docs-cost-lint", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const repo = () => ({
    readme: read("README.md"),
    config: parseJsonc(read("wrangler.jsonc")),
    permissions: JSON.parse(read("deploy/permissions.json")),
  });

  it("passes on the repo and covers every binding type in wrangler.jsonc", () => {
    const docs = repo();
    expect(checkDocsCost(docs)).toEqual([]);
    expect(bindingNames(docs.config)).toEqual(
      ["AI", "ASSETS", "ASSISTANT", "DB", "FILES", "TASK_WORKFLOW", "triggers"].sort(),
    );
  });

  it("fails when a binding has no cost note or no permission entry", () => {
    const docs = repo();
    docs.config.kv_namespaces = [{ binding: "CACHE" }];
    expect(checkDocsCost(docs)).toEqual([
      'CACHE: no cost row in the README "What this costs" table',
      'CACHE: no entry lists it in deploy/permissions.json "bindings"',
    ]);
    const blank = repo();
    blank.readme = blank.readme.replace(/^\| `DB` .*$/m, "| `DB` | D1 | | |");
    blank.permissions.permissions = blank.permissions.permissions.filter(
      (p: { id: string }) => p.id !== "r2",
    );
    expect(checkDocsCost(blank)).toEqual([
      'DB: no cost row in the README "What this costs" table',
      'FILES: no entry lists it in deploy/permissions.json "bindings"',
    ]);
    const short = repo();
    short.readme = short.readme.replace(/^\| `DB` .*$/m, "| `DB` | D1 |");
    expect(checkDocsCost(short)).toEqual(['DB: no cost row in the README "What this costs" table']);
    const piped = repo();
    piped.readme = piped.readme.replace(
      /^\| `DB` .*$/m,
      "| `DB` | D1 | 5 GB \\| 25B rows | $0.75/GB |",
    );
    expect(checkDocsCost(piped)).toEqual([]);
    // An escaped backslash before a pipe leaves the pipe a delimiter, so the row has four cells.
    piped.readme = piped.readme.replace("5 GB \\| 25B rows", "5 GB \\\\| 25B rows");
    expect(checkDocsCost(piped)).toEqual(['DB: no cost row in the README "What this costs" table']);
    const env = repo();
    env.config.env = {
      staging: { vars: { binding: "NOT_A_BINDING" }, queues: { producers: [{ binding: "JOBS" }] } },
    };
    expect(checkDocsCost(env)).toEqual([
      'JOBS: no cost row in the README "What this costs" table',
      'JOBS: no entry lists it in deploy/permissions.json "bindings"',
    ]);
  });

  it("requires the section, the baseline, the unlimited caveat and a price date", () => {
    const { readme, ...rest } = repo();
    expect(checkDocsCost({ ...rest, readme: "# x\n" })).toEqual([
      'README.md: no "## What this costs" section',
    ]);
    const vague = readme
      .replace(/Prices as of [\d-]+/, "Prices as of recently")
      .replace("Workers Paid, $5 per month", "Workers Paid")
      .replace("does not include unlimited usage", "covers most use");
    expect(checkDocsCost({ ...rest, readme: vague })).toHaveLength(3);
  });
});
