// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { findDependencyViolations, findPortViolations } from "../check-boundaries.mjs";
import { findViolations } from "../check-builder-independence.mjs";
import { checkBudget, findLeakedNames, serverOnlyNames } from "../check-bundles.mjs";
import {
  checkPnpmPolicy,
  checkRenovatePolicy,
  checkRuntimeDependencies,
  checkWorkflow,
  runtimeClosure,
} from "../check-supply-chain.mjs";
import { disallowed, flatten } from "../generate-notices.mjs";

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

  it("lists the Worker's runtime closure and flags unreviewed packages", () => {
    const lock = `
importers:
  apps/worker:
    dependencies:
      '@opa/db': { specifier: 'workspace:*', version: link:../../packages/db }
      hono: { specifier: 4.0.0, version: 4.0.0 }
    devDependencies:
      vitest: { specifier: 1.0.0, version: 1.0.0 }
  packages/db:
    dependencies:
      drizzle-orm: { specifier: 1.0.0, version: 1.0.0(@cloudflare/workers-types@5.0.0) }
snapshots:
  hono@4.0.0: {}
  vitest@1.0.0: { dependencies: { evil: 1.0.0 } }
  drizzle-orm@1.0.0(@cloudflare/workers-types@5.0.0):
    dependencies: { '@cloudflare/workers-types': 5.0.0, left-pad: 2.0.0 }
    optionalDependencies: { strip: string-width@4.0.0 }
`;
    expect(runtimeClosure(lock)).toEqual([
      "@cloudflare/workers-types",
      "drizzle-orm",
      "hono",
      "left-pad",
      "string-width",
    ]);
    expect(checkRuntimeDependencies(lock)).toHaveLength(2);
    expect(checkRuntimeDependencies(lock)[1]).toContain('"string-width"');
  });

  it("follows importer optional dependencies and aliases", () => {
    const lock = `
importers:
  apps/worker:
    dependencies:
      hono: { specifier: npm:evil@1.0.0, version: evil@1.0.0 }
    optionalDependencies:
      extra: { specifier: 1.0.0, version: 1.0.0 }
snapshots:
  evil@1.0.0: {}
  extra@1.0.0: { dependencies: { deep: 2.0.0 } }
`;
    expect(runtimeClosure(lock)).toEqual(["deep", "evil", "extra"]);
  });

  it("fails when the lockfile is missing", () => {
    expect(checkRuntimeDependencies(null)).toEqual([
      "pnpm-lock.yaml: missing, so the Worker's runtime dependencies can't be checked",
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
