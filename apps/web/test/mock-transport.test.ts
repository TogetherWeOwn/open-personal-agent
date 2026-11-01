// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { describe, expect, it, vi } from "vitest";
import {
  createMockTransport,
  MOCK_QUEUED,
  MOCK_SLOW_START,
  MOCK_TIMELINE,
} from "../src/chat/mock-transport";

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

  it("scripts a searching run with a tool call, taint and usage", async () => {
    vi.useFakeTimers();
    try {
      const events: HarnessEvent[] = [];
      const transport = createMockTransport();
      transport.connect(
        (e) => events.push(e),
        () => {},
      );
      transport.send("c1", MOCK_TIMELINE);
      expect(events.map((e) => e.type)).toEqual(["turn.started"]);
      await vi.advanceTimersByTimeAsync(3000);
      expect(events.map((e) => e.type)).toEqual([
        "turn.started",
        "step.started",
        "usage.updated",
        "tool.called",
        "tool.result",
        "context.tainted",
        "step.completed",
        "message.completed",
        "turn.completed",
      ]);
      expect(events[3]?.payload).toMatchObject({ tool: "fetch", risk: "read" });
      expect(events[5]?.payload).toMatchObject({
        source: { kind: "web", label: "docs.example" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues a follow-up behind the scripted run", async () => {
    vi.useFakeTimers();
    try {
      const events: HarnessEvent[] = [];
      const transport = createMockTransport();
      transport.connect(
        (e) => events.push(e),
        () => {},
      );
      transport.send("c1", MOCK_QUEUED);
      await vi.advanceTimersByTimeAsync(3000);
      expect(events.map((e) => e.type)[1]).toBe("turn.queued");
      expect(events[1]?.payload).toMatchObject({ text: "And the follow-up", position: 1 });
      expect(events.at(-1)?.type).toBe("turn.completed");
    } finally {
      vi.useRealTimers();
    }
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
