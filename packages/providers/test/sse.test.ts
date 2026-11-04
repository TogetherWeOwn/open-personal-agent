// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { SseParser } from "../src/sse";

describe("bounded SSE framing", () => {
  it.each(["\n", "\r", "\r\n"])(
    "joins data and ignores other fields across split %j delimiters",
    (eol) => {
      const parser = new SseParser();
      const wire = [
        ": ping",
        "id: ignored",
        "event: message",
        "data: first",
        "data:second",
        "",
        "",
      ].join(eol);
      const events = [...wire].flatMap((byte) => parser.push(byte));
      events.push(...parser.push("", true));
      expect(events).toEqual([{ data: "first\nsecond", event: "message" }]);
    },
  );

  it.each(["data: cut", "data: cut\n", "data: cut\r", "data: cut\r\n"])(
    "discards incomplete EOF event %j",
    (wire) => {
      const parser = new SseParser();
      expect([...parser.push(wire), ...parser.push("", true)]).toEqual([]);
    },
  );

  it("bounds multiline events and partial lines, and resets its bound after dispatch", () => {
    const partial = new SseParser(20);
    partial.push("data: ");
    expect(() => partial.push("x".repeat(15))).toThrow("SSE event too large");
    const multiline = new SseParser(20);
    multiline.push("data: first\n");
    expect(() => multiline.push("data: second\n")).toThrow("SSE event too large");
    const reset = new SseParser(20);
    expect(reset.push("data: first\n\ndata: second\n\n")).toHaveLength(2);
  });
});
