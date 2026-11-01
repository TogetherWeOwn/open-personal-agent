// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { findVaultDependencies, findViolations } from "../check-scoped-access.mjs";
import { findBundleViolations } from "../check-worker-bundle.mjs";

const lint = (path: string, text: string) => findViolations([{ path, text }]).length;
const KEY = ["OPA", "MASTER", "KEY"].join("_");
const ENV_IMPORT = 'import { DurableObject, env } from "cloudflare:workers";';

describe("scoped-access lint", () => {
  it("fails on raw bindings and Durable Object names outside packages/db", () => {
    for (const text of [
      "c.env.DB.prepare(q)",
      "env?.FILES.get(k)",
      'env["ASSISTANT"]',
      "const { DB } = env;",
      "function f({ DB }: Env) {}",
      "const f = ({ FILES }) => FILES;",
      "function f({ ASSISTANT }) {}",
      "const f = ({ DB, ...rest }: Env): void => {};",
      "ns.idFromName(id)",
    ]) {
      expect([
        lint("apps/worker/src/a.ts", text),
        lint("packages/db/src/a.ts", text),
        lint("apps/worker/test/a.ts", text),
      ]).toEqual([1, 0, 0]);
    }
    for (const text of [
      "interface B {\n  DB: D1Database;\n}",
      'type T = Pick<Bindings, "DB">;',
      "const f = ({ env }: Ctx) => repo(env);",
    ]) {
      expect(lint("apps/worker/src/env.ts", text), text).toBe(0);
    }
    expect(findViolations([{ path: "apps/worker/src/a.ts", text: "\nenv.DB" }])).toEqual([
      "apps/worker/src/a.ts:2: raw-binding: use the scoped repository in @opa/db (ADR 0010 D3)",
    ]);
  });

  it("limits scope minting, the master key and the runtime env", () => {
    const cases: [string, string, number][] = [
      ["apps/worker/src/chat.ts", "scopeFromSession(s)", 1],
      ["apps/worker/src/auth/session.ts", "scopeFromSession(s)", 0],
      ["apps/worker/src/health.ts", `env.${KEY}`, 1],
      ["packages/core/src/a.ts", `"${KEY}_PREV"`, 1],
      ["apps/worker/src/compose.ts", `env.${KEY}`, 0],
      ["apps/worker/src/index.ts", `env.${KEY}`, 1],
      ["packages/vault/src/kek.ts", `env.${KEY}`, 0],
      ["apps/worker/src/app.ts", ENV_IMPORT, 1],
      ["apps/worker/src/app.ts", 'import * as cf from "cloudflare:workers";', 1],
      ["apps/worker/src/app.ts", 'import { DurableObject } from "cloudflare:workers";', 0],
      ["apps/worker/src/compose.ts", ENV_IMPORT, 0],
      ["apps/worker/src/index.ts", ENV_IMPORT, 1],
    ];
    for (const [path, text, n] of cases) expect(lint(path, text), `${path}: ${text}`).toBe(n);
  });
});

describe("vault dependency check", () => {
  it("fails if packages/vault lists any runtime dependency", () => {
    const pkg = (fields: object) => JSON.stringify({ name: "@opa/vault", ...fields });
    expect(findVaultDependencies(pkg({ devDependencies: { vitest: "5" } }))).toEqual([]);
    expect(findVaultDependencies(pkg({ dependencies: { "left-pad": "1" } }))).toEqual([
      "packages/vault/package.json: dependencies: left-pad: the vault has none (ADR 0010 D4.1 #4)",
    ]);
    expect(findVaultDependencies(pkg({ peerDependencies: { hono: "4" } }))).toHaveLength(1);
    expect(findVaultDependencies(pkg({ optionalDependencies: { x: "1" } }))).toHaveLength(1);
  });
});

describe("worker bundle check", () => {
  const dep = "node_modules/.pnpm/evil@1.0.0/node_modules/evil/index.js";
  const bundle = (module: string, code: string) =>
    `var x;\n// apps/worker/src/app.ts\nx = 1;\n// ${module}\n${code}\n`;

  it("fails when a dependency reads the runtime env or names the master key", () => {
    expect(findBundleViolations(bundle(dep, ENV_IMPORT))).toEqual([
      `${dep}: cloudflare-env (ADR 0010 D4.1 #3)`,
    ]);
    expect(findBundleViolations(bundle(dep, 'await import("cloudflare:workers")'))).toHaveLength(1);
    expect(findBundleViolations(bundle(dep, `globalThis.${KEY}`))).toHaveLength(1);
    expect(findBundleViolations(bundle(dep, "export const ok = 1;"))).toEqual([]);
  });

  it("allows the composition root and reviewed allowlist entries", () => {
    expect(
      findBundleViolations(bundle("apps/worker/src/compose.ts", `${ENV_IMPORT} env.${KEY}`)),
    ).toEqual([]);
    const entry = { module: dep, rule: "master-key", reason: "reviewed" };
    expect(findBundleViolations(bundle(dep, KEY), [entry])).toEqual([]);
    expect(findBundleViolations(bundle(dep, KEY), [{ ...entry, reason: "" }])).toHaveLength(1);
  });
});
