// SPDX-License-Identifier: Apache-2.0
// Tool input validation (M3-03 AC2): the model's arguments are checked against the manifest's
// JSON Schema before policy and execution. A small subset of JSON Schema, with no dependency
// (M2-16 note). It fails closed: a keyword it doesn't know makes every input invalid, so a schema
// can't look stricter than it is checked.

type Schema = Record<string, unknown>;

/** Keywords that describe a value but assert nothing about it. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples"]);
const ASSERTIONS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
  for (const key of Object.keys(schema)) {
    if (!ANNOTATIONS.has(key) && !ASSERTIONS.has(key)) {
      return [`${path}: the schema keyword "${key}" is not supported`];
    }
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
 * Parses the JSON text the model wrote for a call and validates it. The input of a tool is always
 * an object (the manifest's schema is `type: "object"`).
 */
export function parseInput(
  schema: Schema,
  text: string,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  let input: unknown;
  try {
    input = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch {
    return { ok: false, error: "The arguments are not valid JSON." };
  }
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
 * Canonical JSON: object keys sorted, no whitespace. The `tool.called` and approval payloads use it,
 * so the same arguments always read (and later hash, M3-07) the same.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
