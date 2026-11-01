// SPDX-License-Identifier: Apache-2.0
// Tool input validation (M3-03 AC2): the model's arguments are checked against the manifest's
// JSON Schema before policy and execution. A small subset of JSON Schema, with no dependency
// (M2-16 note). It fails closed: a keyword it doesn't know, or a keyword value it can't check (a
// tuple `items`, a string `maxLength`), makes every input invalid, so a schema can't look stricter
// than it is checked.
import { CANONICAL_LIMITS, CanonicalError, jcs } from "@opa/policy";

type Schema = Record<string, unknown>;

/** Keywords that describe a value but assert nothing about it. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples"]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const isType = (v: unknown) => typeof v === "string" && TYPES.has(v);

/** The keywords it checks, each with the shape of value it can check. */
const ASSERTIONS: Record<string, (v: unknown) => boolean> = {
  type: (v) => isType(v) || (Array.isArray(v) && v.length > 0 && v.every(isType)),
  properties: (v) => isRecord(v) && Object.values(v).every(isRecord),
  required: (v) => Array.isArray(v) && v.every((r) => typeof r === "string"),
  additionalProperties: (v) => typeof v === "boolean" || isRecord(v),
  enum: Array.isArray,
  const: () => true,
  items: isRecord, // one schema for every item; tuples and `items: false` aren't supported
  minItems: isCount,
  maxItems: isCount,
  minLength: isCount,
  maxLength: isCount,
  minimum: Number.isFinite,
  maximum: Number.isFinite,
};

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const typeMatches = (type: unknown, actual: string): boolean =>
  type === actual || (type === "number" && actual === "integer");

/** Structural equality for JSON values (`enum`, `const`). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => same(a[k], b[k]));
  }
  return false;
}

/** What is wrong with `value` under `schema`, as messages the model can act on; empty if valid. */
export function validate(schema: Schema, value: unknown, path = "input"): string[] {
  for (const [key, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    const check = Object.hasOwn(ASSERTIONS, key) ? ASSERTIONS[key] : undefined;
    if (!check) return [`${path}: the schema keyword "${key}" is not supported`];
    if (!check(v))
      return [`${path}: the schema keyword "${key}" has a value that can't be checked`];
  }
  const actual = typeOf(value);
  const { type } = schema;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeMatches(t, actual))) {
      return [`${path}: expected ${types.join(" or ")}, got ${actual}`];
    }
  }
  const problems: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => same(v, value))) {
    problems.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && !same(schema.const, value)) {
    problems.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      problems.push(`${path}: must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      problems.push(`${path}: must be at most ${schema.maxLength} characters`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      problems.push(`${path}: must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      problems.push(`${path}: must be at most ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      problems.push(`${path}: needs at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      problems.push(`${path}: allows at most ${schema.maxItems} items`);
    }
    if (isRecord(schema.items)) {
      const items = schema.items;
      for (const [i, v] of value.entries()) problems.push(...validate(items, v, `${path}[${i}]`));
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) {
          problems.push(`${path}.${name}: is required`);
        }
      }
    }
    for (const [name, v] of Object.entries(value)) {
      const sub = properties[name];
      if (Object.hasOwn(properties, name) && isRecord(sub)) {
        problems.push(...validate(sub, v, `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}.${name}: is not allowed`);
      } else if (isRecord(schema.additionalProperties)) {
        problems.push(...validate(schema.additionalProperties, v, `${path}.${name}`));
      }
    }
  }
  return problems;
}

/**
 * Why `text` can't be read one way only, or `null`. `JSON.parse` keeps the last of two equal keys,
 * so `{"to":"a","to":"b"}` could show one recipient and send to the other; an approval binds the
 * parsed value, so such text is refused instead (crypto review C3). `text` is valid JSON already.
 */
function ambiguity(text: string): string | null {
  const open: (Set<string> | null)[] = []; // an object's keys so far; `null` for an array
  let key = false; // the next string is an object key
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const keys = open.at(-1);
      if (keys && key) {
        const name = JSON.parse(text.slice(i, end + 1)) as string;
        if (keys.has(name)) return `the key "${name}" appears twice`;
        keys.add(name);
        key = false;
      }
      i = end;
    } else if (ch === "{" || ch === "[") {
      open.push(ch === "{" ? new Set() : null);
      key = ch === "{";
      if (open.length > CANONICAL_LIMITS.depth) return "they are nested too deeply";
    } else if (ch === "}" || ch === "]") {
      open.pop();
      key = false;
    } else if (ch === ",") {
      key = open.at(-1) != null;
    }
  }
  return null;
}

/** An integer JSON can carry but a double can't: it was rounded when it was parsed. */
function unsafeInteger(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.some(unsafeInteger);
  if (isRecord(value)) return Object.values(value).some(unsafeInteger);
  return false;
}

/**
 * Parses the JSON text the model wrote for a call and validates it. The input of a tool is always
 * an object (the manifest's schema is `type: "object"`). Input that an approval couldn't bind
 * exactly is refused before the schema runs: duplicate keys, integers past 2^53, lone surrogates,
 * and values nested too deeply (M3-07 AC1, crypto review C3). Size is the schema's business here;
 * a gated call too large to approve is refused when it would ask.
 */
export function parseInput(
  schema: Schema,
  text: string,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  let input: unknown;
  const source = text.trim() === "" ? "{}" : text;
  try {
    input = JSON.parse(source);
  } catch {
    return { ok: false, error: "The arguments are not valid JSON." };
  }
  let strict = ambiguity(source);
  if (!strict && unsafeInteger(input)) {
    strict = "an integer is too large to keep exactly; send it as a string";
  }
  if (!strict) {
    try {
      jcs(input, Number.POSITIVE_INFINITY);
    } catch (e) {
      if (!(e instanceof CanonicalError)) throw e;
      strict = e.message;
    }
  }
  if (strict) return { ok: false, error: `The arguments can't be used: ${strict}.` };
  const problems = validate({ ...schema, type: "object" }, input);
  if (problems.length > 0 || !isRecord(input)) {
    return {
      ok: false,
      error: `The arguments don't match the tool's schema: ${problems.join("; ")}`,
    };
  }
  return { ok: true, input };
}

/**
 * Canonical JSON (RFC 8785): the `tool.called` and approval payloads use it, so the same
 * arguments always read, and hash (M3-07), the same. Only parsed input reaches it.
 */
export const canonical = (value: unknown): string => jcs(value, Number.POSITIVE_INFINITY);
