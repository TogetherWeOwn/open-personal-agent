// SPDX-License-Identifier: Apache-2.0
// Canary secrets (ADR 0010 D11, R7 M2-5+). Every secret and token-shaped input carries the canary;
// no response, header, generated URL or console line may contain it. The canary-scan CI job also
// scans this suite's console output and the built bundles.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { app } from "@opa/server/app";
import { beforeAll, expect, it, vi } from "vitest";
import { canaryForms } from "../../../scripts/canary-forms.mjs";
import { compose, type WorkerEnv } from "../src/compose";

const env = workerEnv as unknown as WorkerEnv & {
  TEST_MIGRATIONS: D1Migration[];
  OPA_CANARY: string;
};
const canary = env.OPA_CANARY;
const secrets = {
  OPA_MASTER_KEY: `${canary}-master`,
  OPA_MASTER_KEY_PREV: `${canary}-prev`,
  OPA_SESSION_SECRET: `${canary}-session`,
  OPA_SETUP_TOKEN: `${canary}-setup`,
};
const throwing = {
  prepare() {
    throw new Error(`database said ${canary}`);
  },
} as unknown as D1Database;

const requests: [string, RequestInit][] = [
  ["/api/health", {}],
  ["/setup", {}],
  [`/api/nope?token=${canary}`, { headers: { Authorization: `Bearer ${canary}` } }],
  [`/api/health?key=${canary}`, { method: "POST", headers: { Origin: `https://${canary}.test` } }],
  [
    "/api/x",
    {
      method: "POST",
      headers: { Origin: "https://opa.test", Cookie: `s=${canary}` },
      body: canary,
    },
  ],
];
const forms = canaryForms(canary);
const leaks = (text: string) => forms.some((f) => text.includes(f));
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
  vi.spyOn(console, m),
);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it.each([env.DB, throwing])("canaries never appear in output", async (db) => {
  const bindings = await compose({ ...env, ...secrets, DB: db });
  // The env filter (D4.1 #1): the app never receives the master keys.
  expect(JSON.stringify(bindings)).not.toMatch(/-master|-prev/);
  for (const [path, init] of requests) {
    const res = await app.request(`https://opa.test${path}`, init, bindings);
    expect(leaks(JSON.stringify([...res.headers])), `${path} headers`).toBe(false);
    expect(leaks(await res.text()), `${path} body`).toBe(false);
  }
  const output = consoleSpies
    .flatMap((s) => s.mock.calls.flat())
    .map(String)
    .join("\n");
  expect(output).toContain('"event":"request"'); // the request log ran, so this covers it
  expect(leaks(output)).toBe(false);
});
