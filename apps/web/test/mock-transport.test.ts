// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { describe, expect, it } from "vitest";
import { createMockTransport, MOCK_SLOW_START } from "../src/chat/mock-transport";

describe("createMockTransport", () => {
  it("refuses only its exact limit commands, not a name an object inherits", async () => {
    const events: HarnessEvent[] = [];
    const transport = createMockTransport(60_000);
    transport.connect(
      (e) => events.push(e),
      () => {},
    );
    transport.send("c1", "toString");
    transport.send("c1", "/mock slow down");
    await Promise.resolve();
    transport.cancel();
    expect(events.map((e) => [e.type, e.turnId === ""])).toEqual([
      ["turn.started", false],
      ["turn.failed", true],
      ["turn.cancelled", false],
    ]);
    expect(events[1]?.payload).toMatchObject({ reason: "slow_down" });
  });

  it("takes a waiting send back on the running turn", async () => {
    const events: HarnessEvent[] = [];
    const transport = createMockTransport(60_000);
    transport.connect(
      (e) => events.push(e),
      () => {},
    );
    transport.send("c1", "hello");
    transport.dequeue("c1", "queued-1");
    // A dequeue for another chat's turn is not this turn's to answer.
    transport.dequeue("c2", "queued-2");
    await Promise.resolve();
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["turn.started", { messageId: "mock-1-reply" }],
      ["turn.dequeued", { messageId: "queued-1", conversationId: "c1" }],
    ]);
    expect(events[1]?.turnId).toBe("mock-1");
  });

  it("starts a slow-start turn stopped before its start, then cancels it", () => {
    const events: HarnessEvent[] = [];
    const transport = createMockTransport(60_000);
    transport.connect(
      (e) => events.push(e),
      () => {},
    );
    transport.send("c1", MOCK_SLOW_START);
    expect(events).toEqual([]);
    transport.cancel();
    expect(events.map((e) => [e.type, e.turnId])).toEqual([
      ["turn.started", "mock-1"],
      ["turn.cancelled", "mock-1"],
    ]);
  });
});
