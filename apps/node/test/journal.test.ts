// SPDX-License-Identifier: Apache-2.0
// The Node step journal (M3-23b): replay across restarts, inline retries and timeout, and
// event waits. The port-level behaviour it shares with the Workflows adapter (cancel and
// limit guards, the envelope, offload, redaction, budget, progress) is pinned by the task
// contract in `test/contract/tasks.ts` against both roots instead of here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openSqlite, sqliteD1 } from "../src/d1";
import { createSqliteJournal, postTaskEvent } from "../src/journal";
import { migrate } from "../src/migrate";

const dir = mkdtempSync(join(tmpdir(), "opa-journal-"));
const sqlite = openSqlite(join(dir, "journal.sqlite"));
migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
const db = sqliteD1(sqlite);
afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("journal replay", () => {
  it("replays a finished step from its row instead of re-running it", async () => {
    const journal = createSqliteJournal({ db, instanceId: "replay-1" });
    const ran = vi.fn(async () => ({ n: 1 }));
    expect(await journal.do("s1", {}, ran)).toEqual({ n: 1 });
    expect(ran).toHaveBeenCalledTimes(1);
    // A new journal object over the same database and instance: a resumed run.
    const resumed = createSqliteJournal({ db, instanceId: "replay-1" });
    expect(await resumed.do("s1", {}, ran)).toEqual({ n: 1 });
    expect(ran).toHaveBeenCalledTimes(1);
    // Another instance re-runs: the replay key includes the instance id.
    const other = createSqliteJournal({ db, instanceId: "replay-2" });
    expect(await other.do("s1", {}, ran)).toEqual({ n: 1 });
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it("a step interrupted before its write runs again on resume", async () => {
    const journal = createSqliteJournal({ db, instanceId: "crash-1" });
    await expect(
      journal.do("boom", { retries: { limit: 0, delayMs: 0 } }, async () => {
        throw new Error("crash mid-step");
      }),
    ).rejects.toThrow("crash mid-step");
    const ran = vi.fn(async () => "recovered" as const);
    expect(await journal.do("boom", {}, ran)).toBe("recovered");
    expect(ran).toHaveBeenCalledTimes(1);
  });
});

describe("journal retries and timeout", () => {
  it("retries a failing step and then journals the success", async () => {
    const journal = createSqliteJournal({ db, instanceId: "retry-1" });
    let attempts = 0;
    const out = await journal.do("flaky", { retries: { limit: 2, delayMs: 1 } }, async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(`attempt ${attempts}`);
      return "steady";
    });
    expect(out).toBe("steady");
    expect(attempts).toBe(3);
    const resumed = createSqliteJournal({ db, instanceId: "retry-1" });
    expect(await resumed.do("flaky", {}, async () => "changed")).toBe("steady");
  });

  it("gives up after the retry limit, and a write runs exactly once", async () => {
    const journal = createSqliteJournal({ db, instanceId: "retry-2" });
    const ran = vi.fn(async () => {
      throw new Error("always");
    });
    await expect(journal.do("s1", { retries: { limit: 2, delayMs: 1 } }, ran)).rejects.toThrow(
      "always",
    );
    expect(ran).toHaveBeenCalledTimes(3);
    const write = vi.fn(async () => {
      throw new Error("write failed");
    });
    await expect(journal.do("s2", { retries: { limit: 0, delayMs: 0 } }, write)).rejects.toThrow(
      "write failed",
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("times a hung step out", async () => {
    const journal = createSqliteJournal({ db, instanceId: "timeout-1" });
    await expect(
      journal.do(
        "hung",
        { retries: { limit: 0, delayMs: 0 }, timeoutMs: 20 },
        () => new Promise<never>(() => {}),
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe("journal events", () => {
  it("delivers a posted event to exactly one waiter", async () => {
    const journal = createSqliteJournal({ db, instanceId: "events-1", pollIntervalMs: 1 });
    const first = journal.waitForEvent("approval", { type: "approval", timeoutMs: 2_000 });
    const second = journal.waitForEvent("approval-2", { type: "approval", timeoutMs: 2_000 });
    await postTaskEvent(db, "events-1", "approval", { decision: "approve" });
    expect(await first).toEqual({ payload: { decision: "approve" } });
    await postTaskEvent(db, "events-1", "approval", { decision: "deny" });
    expect(await second).toEqual({ payload: { decision: "deny" } });
    // Both rows were consumed: nothing is left for a third waiter.
    await expect(
      journal.waitForEvent("approval-3", { type: "approval", timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });

  it("ignores another instance's and another type's events", async () => {
    const journal = createSqliteJournal({ db, instanceId: "events-2", pollIntervalMs: 1 });
    await postTaskEvent(db, "events-other", "approval", { decision: "approve" });
    await postTaskEvent(db, "events-2", "other", { decision: "approve" });
    await expect(
      journal.waitForEvent("approval", { type: "approval", timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
  });

  it("replays a consumed wait after a resume instead of timing out", async () => {
    const journal = createSqliteJournal({ db, instanceId: "events-resume", pollIntervalMs: 1 });
    await postTaskEvent(db, "events-resume", "approval", { decision: "approve" });
    expect(
      await journal.waitForEvent("approval:1", { type: "approval", timeoutMs: 2_000 }),
    ).toEqual({ payload: { decision: "approve" } });
    // A new journal object over the same database and instance: a resumed run. The event
    // row is gone, but the wait replays its payload from the journal.
    const resumed = createSqliteJournal({ db, instanceId: "events-resume", pollIntervalMs: 1 });
    expect(await resumed.waitForEvent("approval:1", { type: "approval", timeoutMs: 50 })).toEqual({
      payload: { decision: "approve" },
    });
  });
});
