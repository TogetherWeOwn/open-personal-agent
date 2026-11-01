// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { addContext, type ContextEvent, TRUSTED, taintOf } from "../src/index";

describe("taintOf", () => {
  it.each<[ContextEvent, string]>([
    [{ kind: "system" }, "trusted"],
    [{ kind: "user_message" }, "trusted"],
    [{ kind: "assistant_message" }, "trusted"],
    [{ kind: "web", label: "example.com" }, "untrusted"],
    [{ kind: "file", label: "notes.pdf" }, "untrusted"],
    [{ kind: "tool", label: "web_fetch" }, "untrusted"],
    [{ kind: "memory", trust: "system", label: "m1" }, "trusted"],
    [{ kind: "memory", trust: "user", label: "m2" }, "trusted"],
    [{ kind: "memory", trust: "inferred", label: "m3" }, "untrusted"],
    [{ kind: "memory", trust: "external", label: "m4" }, "untrusted"],
  ])("labels %j as %s", (event, taint) => {
    expect(taintOf(event)).toBe(taint);
  });
});

describe("addContext", () => {
  it("stays trusted on trusted content", () => {
    const state = addContext(addContext(TRUSTED, { kind: "user_message" }), { kind: "system" });
    expect(state).toEqual({ taint: "trusted", sources: [] });
    expect(Object.isFrozen(TRUSTED)).toBe(true);
  });

  it("is sticky once untrusted content arrives, and records each cause", () => {
    let state = addContext(TRUSTED, { kind: "web", label: "example.com" });
    state = addContext(state, { kind: "user_message" });
    state = addContext(state, { kind: "memory", trust: "user", label: "m1" });
    state = addContext(state, { kind: "memory", trust: "external", label: "m2" });
    expect(state).toEqual({
      taint: "untrusted",
      sources: [
        { kind: "web", label: "example.com" },
        { kind: "memory", label: "m2" },
      ],
    });
  });

  it("carries across task promotion as plain data", () => {
    const turn = addContext(TRUSTED, { kind: "file", label: "notes.pdf" });
    const task = addContext(JSON.parse(JSON.stringify(turn)), { kind: "user_message" });
    expect(task.taint).toBe("untrusted");
  });
});
