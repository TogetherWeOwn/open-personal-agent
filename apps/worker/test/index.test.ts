// SPDX-License-Identifier: Apache-2.0
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/compose";
import worker from "../src/index";

describe("worker", () => {
  // After the claim the same route is a JSON 404 (setup.test.ts).
  it("returns JSON 403 for API routes before the claim", async () => {
    const res = await exports.default.fetch("https://opa.test/api/nope");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_claimed" });
  });

  // capnweb parks the cloudflare:workers module, master keys in its env, on globalThis (D4.1 #3).
  it("leaves no module env reachable from globalThis once loaded", () => {
    const holdsEnv = (key: PropertyKey) => {
      const value = Reflect.getOwnPropertyDescriptor(globalThis, key)?.value;
      return typeof value === "object" && value !== null && "env" in value;
    };
    // `process` comes from the nodejs_compat flag the test pool adds; wrangler.jsonc doesn't set it.
    const keys = Reflect.ownKeys(globalThis).filter((k) => k !== "process");
    expect(keys.filter(holdsEnv).map(String)).toEqual([]);
  });

  it("runs the scheduled stub", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ cron: "*/10 * * * *" }),
      {} as WorkerEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);
  });
});
