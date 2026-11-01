// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";

// Boots the bundle from `pnpm deploy:dry-run` (dist/worker), not the sources. Workers AI is
// remote-only and needs an account, so the harness runs without it and health reports degraded.
const { ai: _ai, ...config } = unstable_readConfig({ config: "wrangler.jsonc" });
// The vault refuses a master key shorter than 256 bits (ADR 0010 D4.1 #7).
const vars = {
  OPA_MASTER_KEY: btoa("k".repeat(32)),
  OPA_SESSION_SECRET: "t",
  OPA_SETUP_TOKEN: "t",
};
const server = createTestHarness({
  workers: [{ config: { ...config, vars, main: "dist/worker/index.js", no_bundle: true } }],
});

describe("built Worker", () => {
  beforeAll(async () => {
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
  });
  afterAll(() => server.close());

  it("answers /api/health with the migrated schema", async () => {
    const res = await server.fetch("/api/health");
    expect(await res.json()).toMatchObject({
      status: "degraded",
      schema: { current: true },
      checks: { database: true, storage: true, durableObject: true, workflow: true, ai: false },
    });
  });

  it("serves the web app", async () => {
    const res = await server.fetch("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
