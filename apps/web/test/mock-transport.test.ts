// SPDX-License-Identifier: Apache-2.0
import type { HarnessEvent } from "@opa/core";
import { describe, expect, it } from "vitest";
import { createMockTransport } from "../src/chat/mock-transport";

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
      ["turn.interrupted", false],
    ]);
    expect(events[1]?.payload).toMatchObject({ reason: "slow_down" });
  });
});
