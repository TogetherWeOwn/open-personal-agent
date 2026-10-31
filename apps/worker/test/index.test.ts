// SPDX-License-Identifier: Apache-2.0
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";

describe("worker", () => {
  it("serves /api/health", async () => {
    const res = await exports.default.fetch("https://opa.test/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await exports.default.fetch("https://opa.test/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("runs the scheduled stub", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *" }), {} as Env, ctx);
    await waitOnExecutionContext(ctx);
  });
});
