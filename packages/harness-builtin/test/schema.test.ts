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

describe("parseInput refuses what an approval couldn't bind exactly (M3-07 AC1, C3)", () => {
  const any = { type: "object" } as const;

  it("refuses a key that appears twice, at any depth", () => {
    const twice = parseInput(any, '{"to":"owner@example.com","to":"attacker@example.net"}');
    expect(twice).toEqual({
      ok: false,
      error: 'The arguments can\'t be used: the key "to" appears twice.',
    });
    expect(parseInput(any, '{"a":{"b":1,"b":2}}').ok).toBe(false);
    expect(parseInput(any, '{"a":[{"b":1},{"b":2}]}').ok).toBe(true);
    // An escaped spelling is the same key.
    expect(parseInput(any, '{"to":1,"\\u0074o":2}').ok).toBe(false);
    // A value equal to a key is not a key.
    expect(parseInput(any, '{"a":"b","b":"a","c":["a","a"]}').ok).toBe(true);
    expect(parseInput(any, '{"a\\"":1,"a":2}').ok).toBe(true);
  });

  it("refuses integers past 2^53, lone surrogates and deep nesting", () => {
    expect(parseInput(any, '{"n":12345678901234567890}').ok).toBe(false);
    expect(parseInput(any, '{"n":9007199254740991}').ok).toBe(true);
    expect(parseInput(any, '{"s":"\\ud800"}').ok).toBe(false);
    expect(parseInput(any, '{"s":"\\ud83d\\ude00"}').ok).toBe(true);
    expect(parseInput(any, `{"a":${"[".repeat(40)}${"]".repeat(40)}}`).ok).toBe(false);
  });

  it("leaves size to the schema: input past the approval limit still parses", () => {
    const big = "x".repeat(200_000); // create_artifact takes up to 262,144 characters
    expect(parseInput(any, JSON.stringify({ content: big }))).toEqual({
      ok: true,
      input: { content: big },
    });
    expect(canonical({ content: big })).toHaveLength(200_014);
  });
});

describe("canonical", () => {
  it("sorts keys at every depth", () => {
    expect(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });
});
