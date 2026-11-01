// SPDX-License-Identifier: Apache-2.0
// The per-conversation event log in DO SQLite (M3-03 AC10): a `seq` that never restarts, a
// replay after a point, and a trim that keeps the counter.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/event-log";
import { env } from "./helpers/app";

/** Runs `fn` against a log in a fresh assistant's storage (its own SQLite database). */
const withLog = <T>(name: string, fn: (log: EventLog) => T) =>
  runInDurableObject(env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:log-${name}`)), (_i, state) =>
    fn(new EventLog(state.storage.sql)),
  );

const frame = (seq: number) => `frame-${seq}`;

describe("EventLog (M3-03 AC10)", () => {
  it("allocates a seq per conversation, stores the frame built from it, replays after a point", async () => {
    const seen = await withLog("alloc", (log) => {
      const frames = [
        log.append("c1", "t1", frame),
        log.append("c1", "t1", frame),
        log.append("c2", "t9", frame), // another conversation counts from 1
        log.append("c1", "t2", frame), // a later turn of c1 continues
      ];
      return {
        frames,
        all: log.replay("c1", "t1", 0),
        after: log.replay("c1", "t1", 1),
        other: log.replay("c1", "t2", 0),
        missing: log.replay("c1", "no-such-turn", 0),
      };
    });
    expect(seen.frames).toEqual(["frame-1", "frame-2", "frame-1", "frame-3"]);
    expect(seen.all).toEqual(["frame-1", "frame-2"]);
    expect(seen.after).toEqual(["frame-2"]);
    expect(seen.other).toEqual(["frame-3"]);
    expect(seen.missing).toEqual([]);
  });

  it("trims a settled turn's rows without restarting the conversation's seq", async () => {
    const seen = await withLog("trim", (log) => {
      log.append("c1", "t1", frame);
      log.append("c1", "t1", frame);
      log.append("c1", "t2", frame);
      log.trim("c1", "t1");
      return {
        settled: log.replay("c1", "t1", 0),
        kept: log.replay("c1", "t2", 0),
        next: log.append("c1", "t2", frame),
      };
    });
    expect(seen.settled).toEqual([]);
    expect(seen.kept).toEqual(["frame-3"]);
    expect(seen.next).toBe("frame-4");
  });
});
