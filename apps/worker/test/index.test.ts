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
  // After the claim the same route is a JSON 404 (setup.test.ts).
  it("returns JSON 403 for API routes before the claim", async () => {
    const res = await exports.default.fetch("https://opa.test/api/nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_claimed" });
  });

  it("runs the scheduled stub", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/10 * * * *" }), {} as Env, ctx);
    await waitOnExecutionContext(ctx);
  });
});
