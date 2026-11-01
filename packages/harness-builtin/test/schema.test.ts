// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { canonical, parseInput, validate } from "../src/index";

const schema = {
  type: "object",
  properties: {
    to: { type: "array", items: { type: "string", maxLength: 5 }, minItems: 1 },
    mode: { enum: ["a", "b"] },
    n: { type: "integer", minimum: 1, maximum: 3 },
    meta: { type: "object", additionalProperties: { type: "boolean" } },
  },
  required: ["to"],
  additionalProperties: false,
};

describe("validate", () => {
  it("accepts a matching input and names each problem in one that doesn't", () => {
    expect(validate(schema, { to: ["ab"], mode: "a", n: 2, meta: { x: true } })).toEqual([]);
    expect(
      validate(schema, { to: ["abcdef"], mode: "c", n: 1.5, meta: { x: 1 }, extra: 1 }),
    ).toEqual([
      "input.to[0]: must be at most 5 characters",
      'input.mode: must be one of ["a","b"]',
      "input.n: expected integer, got number",
      "input.meta.x: expected boolean, got integer",
      "input.extra: is not allowed",
    ]);
    expect(validate(schema, { to: [] })).toEqual(["input.to: needs at least 1 items"]);
    expect(validate(schema, {})).toEqual(["input.to: is required"]);
  });

  it("fails closed on a keyword it doesn't check", () => {
    expect(validate({ type: "string", pattern: "^a" }, "b")).toEqual([
      'input: the schema keyword "pattern" is not supported',
    ]);
    expect(validate({ type: "object", properties: { s: { anyOf: [] } } }, { s: 1 })).toHaveLength(
      1,
    );
    // So does a keyword value it can't check: a tuple, a boolean schema, a bound that isn't a number.
    for (const bad of [
      { type: "array", items: [{ type: "integer" }] },
      { type: "array", items: false },
      { type: "object", properties: { x: false } },
      { type: "string", maxLength: "5" },
      { type: "number", maximum: null },
      { type: "strnig" },
      { enum: "a" },
      { type: "object", required: [1] },
    ]) {
      expect(validate(bad, ["oops"])[0]).toMatch(/can't be checked/);
    }
    // Annotations assert nothing, so they are allowed.
    expect(validate({ type: "string", description: "d", title: "t" }, "x")).toEqual([]);
  });
});

describe("parseInput", () => {
  it("parses the model's JSON text and treats empty text as no arguments", () => {
    expect(parseInput({ type: "object" }, "")).toEqual({ ok: true, input: {} });
    expect(parseInput({ type: "object" }, "{oops")).toEqual({
      ok: false,
      error: "The arguments are not valid JSON.",
    });
    expect(parseInput({ type: "object" }, "[1]").ok).toBe(false);
  });
});

describe("canonical", () => {
  it("sorts keys at every depth", () => {
    expect(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });
});
