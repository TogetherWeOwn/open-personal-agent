// SPDX-License-Identifier: Apache-2.0
import type { ApprovalDecision, HarnessEvent } from "@opa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingBatch } from "../src/approvals/api";

const batch: PendingBatch = {
  batchId: "b1",
  conversationId: "c1",
  conversationTitle: null,
  taskId: null,
  createdAt: 0,
  expiresAt: Date.now() + 3_600_000,
  items: [
    {
      approvalId: "a1",
      tool: "create_artifact",
      args: "{}",
      risk: "consequential",
      rule: "default_consequential",
      scopes: ["once"],
      expiresAt: Date.now() + 3_600_000,
    },
  ],
};
const decisions: ApprovalDecision[] = [{ approvalId: "a1", decision: "approve", scope: "once" }];
const resolved = {
  v: 1,
  seq: 1,
  sessionId: "c1",
  turnId: "t1",
  type: "approval.resolved",
  payload: { batchId: "b1", decisions },
} as HarnessEvent;

/** A fresh store over a server that lists `batch` until the POST lands, then nothing. */
async function load(post: (store: typeof import("../src/approvals/store")) => Promise<Response>) {
  vi.resetModules();
  const store = await import("../src/approvals/store");
  let decided = false;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const res = await post(store);
      decided = res.ok;
      return res;
    }
    return Response.json({ batches: decided ? [] : [batch] });
  });
  await store.refreshApprovals();
  return store;
}

const pending = (expiresAt: number): PendingBatch => ({
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

describe("submitDecision", () => {
  it("doesn't call this tab's own answer 'resolved elsewhere' when its event wins the race", async () => {
    // The resumed run's `approval.resolved` arrives before the POST's response.
    const store = await load(async (s) => {
      s.approvalEvent(resolved);
      return Response.json({ status: "resumed" });
    });
    const result = await store.submitDecision(batch, decisions);
    expect(result).toEqual({ kind: "done", status: "resumed" });
    const { receipts, announcement } = store.approvalsSnapshot();
    expect(announcement).not.toMatch(/elsewhere/);
    expect(receipts.map((r) => r.text)).toEqual([
      expect.stringMatching(/^You approved: Save a file/),
    ]);
  });

  it("still reports another tab's answer once its own request failed", async () => {
    const store = await load(async () => Response.json({ error: "stale" }, { status: 409 }));
    expect(await store.submitDecision(batch, decisions)).toEqual({ kind: "changed" });
    await store.refreshApprovals(); // the list still has the batch: the server said "stale"
    store.approvalEvent(resolved);
    expect(store.approvalsSnapshot().announcement).toBe("1 item resolved elsewhere.");
  });
});

describe("the expiry timer", () => {
  it("doesn't read in a loop when this clock runs ahead of the server's", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    // The server still lists a batch that expired 30 s ago by this tab's clock.
    const listed = pending(Date.now() - 30_000);
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
    const listed = pending(Date.now() - 30_000);
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
    let batches = [pending(Date.now() + 60_000)];
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

describe("a decision whose answer was lost", () => {
  const decisions = [{ approvalId: "a1", decision: "approve" as const, scope: "once" as const }];

  it("reads the list again, and a batch it no longer holds leaves without claiming an answer", async () => {
    const listed = batch(Date.now() + 60_000);
    let decidedOnServer = false;
    vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        // The server records the decision, then the response never arrives.
        decidedOnServer = true;
        throw new TypeError("network");
      }
      return Response.json({ batches: decidedOnServer ? [] : [listed] });
    });
    vi.resetModules();
    const store = await import("../src/approvals/store");
    await store.refreshApprovals();
    expect(await store.submitDecision(listed, decisions)).toEqual({ kind: "left" });
    const { batches, receipts } = store.approvalsSnapshot();
    expect(batches).toEqual([]);
    expect(receipts[0]?.text).toMatch(/^No longer waiting: Save a file · .*check the chat\.$/);
  });

  it("keeps the card to try again when the batch is still waiting", async () => {
    const listed = batch(Date.now() + 60_000);
    vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new TypeError("network");
      return Response.json({ batches: [listed] });
    });
    vi.resetModules();
    const store = await import("../src/approvals/store");
    await store.refreshApprovals();
    expect(await store.submitDecision(listed, decisions)).toEqual({ kind: "offline" });
    expect(store.approvalsSnapshot().batches).toEqual([listed]);
  });

  it("takes already_decided on a retry as handled, not as an error", async () => {
    const listed = batch(Date.now() + 60_000);
    vi.stubGlobal("fetch", async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json({ error: "already_decided" }, { status: 409 });
      return Response.json({ batches: [listed] });
    });
    vi.resetModules();
    const store = await import("../src/approvals/store");
    await store.refreshApprovals();
    expect(await store.submitDecision(listed, decisions)).toEqual({ kind: "handled" });
    expect(store.approvalsSnapshot().receipts[0]?.text).toMatch(/^Already answered: /);
  });
});
