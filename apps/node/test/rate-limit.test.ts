// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createNodeApp, SOCKET_ADDRESS_HEADER } from "../src/compose";
import { memoryRateLimit } from "../src/rate-limit";

afterEach(() => vi.useRealTimers());

describe("memoryRateLimit", () => {
  it("allows `limit` per key in each window, then resets", async () => {
    vi.useFakeTimers();
    const limiter = memoryRateLimit(2, 60_000);
    const results = async (key: string, n: number) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push((await limiter.limit({ key })).success);
      return out;
    };
    expect(await results("a", 3)).toEqual([true, true, false]);
    expect(await results("b", 1)).toEqual([true]);
    vi.advanceTimersByTime(60_000);
    expect(await results("a", 1)).toEqual([true]);
  });
});

describe("the public rate limit on Node", () => {
  const dir = mkdtempSync(join(tmpdir(), "opa-limit-"));
  const node = createNodeApp({
    dataDir: dir,
    migrationsDir: join(import.meta.dirname, "../../../migrations"),
    assetsDir: dir,
    vars: {},
  });
  afterAll(() => {
    node.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keys on the socket address, whatever address headers the client sends", async () => {
    const health = (socket: string, i: number) =>
      node.fetch(
        new Request("http://localhost/api/health", {
          headers: { "CF-Connecting-IP": `192.0.2.${i}`, [SOCKET_ADDRESS_HEADER]: `192.0.2.${i}` },
        }),
        { incoming: { socket: { remoteAddress: socket } } },
      );
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await health("203.0.113.1", i)).status);
    expect(statuses.slice(0, 30)).not.toContain(429);
    expect(statuses[30]).toBe(429);
    expect((await health("203.0.113.2", 0)).status).not.toBe(429);
  });
});
