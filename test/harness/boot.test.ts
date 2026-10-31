// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, unstable_readConfig } from "wrangler";

// Boots the bundle from `pnpm deploy:dry-run` (dist/worker), not the sources. Workers AI is
// remote-only and needs an account, so the harness runs without it.
const { ai: _ai, ...config } = unstable_readConfig({ config: "wrangler.jsonc" });
const server = createTestHarness({
  workers: [{ config: { ...config, main: "dist/worker/index.js", no_bundle: true } }],
});

describe("built Worker", () => {
  beforeAll(() => server.listen());
  afterAll(() => server.close());

  it("applies the D1 migrations", async () => {
    await server.getWorker().applyD1Migrations("DB");
  });

  it("answers /api/health", async () => {
    const res = await server.fetch("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves the web app", async () => {
    const res = await server.fetch("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
