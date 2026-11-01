// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingBatch } from "../src/approvals/api";

const batch = (expiresAt: number): PendingBatch => ({
  batchId: "b1",
  conversationId: "c1",
  conversationTitle: null,
  taskId: null,
  createdAt: 0,
  expiresAt,
  items: [
    {
      approvalId: "a1",
      tool: "create_artifact",
      args: "{}",
      risk: "consequential",
      rule: "default_consequential",
      scopes: ["once"],
      expiresAt,
    },
  ],
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the expiry timer", () => {
  it("doesn't read in a loop when this clock runs ahead of the server's", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // The server still lists a batch that expired 30 s ago by this tab's clock.
    const listed = batch(Date.now() - 30_000);
    let reads = 0;
    vi.stubGlobal("fetch", async () => {
      reads++;
      return Response.json({ batches: [listed] });
    });
    vi.resetModules();
    const store = await import("../src/approvals/store");
    await store.refreshApprovals();
    await vi.advanceTimersByTimeAsync(20_000);
    // One read on load, then one per pause: not one per round trip.
    expect(reads).toBe(1 + 20_000 / store.SKEW_RECHECK_MS);
    // The server decides: the card stays while it still lists the batch.
    expect(store.approvalsSnapshot().batches).toEqual([listed]);
  });

  it("asks again after the same pause when a recheck read fails", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const listed = batch(Date.now() - 30_000);
    const readAt: number[] = [];
    vi.stubGlobal("fetch", async () => {
      readAt.push(Date.now());
      // The first recheck fails; the load and every later read succeed.
      if (readAt.length === 2) return new Response(null, { status: 503 });
      return Response.json({ batches: [listed] });
    });
    vi.resetModules();
    const store = await import("../src/approvals/store");
    await store.refreshApprovals();
    await vi.advanceTimersByTimeAsync(store.SKEW_RECHECK_MS);
    expect(readAt).toHaveLength(2);
    // No immediate retry: the next read waits the full pause after the failed one.
    await vi.advanceTimersByTimeAsync(store.SKEW_RECHECK_MS - 1);
    expect(readAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(readAt).toEqual([1_000_000, 1_005_000, 1_010_000]);
    expect(store.approvalsSnapshot().status).toBe("ready");
  });

  it("drops a batch when it expires and reads the list again", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    let batches = [batch(Date.now() + 60_000)];
    let reads = 0;
    vi.stubGlobal("fetch", async () => {
      reads++;
      return Response.json({ batches });
    });
    vi.resetModules();
    const store = await import("../src/approvals/store");
    await store.refreshApprovals();
    batches = [];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(2);
    expect(store.approvalsSnapshot().batches).toEqual([]);
  });
});
