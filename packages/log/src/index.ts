// SPDX-License-Identifier: Apache-2.0
// The allowlist logger (ADR 0010 D11). Only fields named in LOG_FIELDS are written, as scalars,
// and every string is redacted and truncated. It can't log an object, a URL, a header, an error
// message or a stack trace.

// Every runtime has a console; this package loads no runtime's types.
declare const console: { log(line: string): void };

/**
 * Add a field only once it can never carry a secret, a token or user content. `route` is the
 * matched route pattern (`/api/conversations/:id`), never the request URL.
 */
export const LOG_FIELDS = [
  "count",
  "durationMs",
  "errorName",
  "method",
  "reason",
  "route",
  "status",
] as const;
export type LogFields = Partial<Record<(typeof LOG_FIELDS)[number], string | number | boolean>>;

const SECRET_SHAPES = [
  /\b(?:bearer|basic)\s+\S+/gi,
  /\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, // JWT
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][\w-]{8,}/gi, // vendor API keys
  /[A-Za-z0-9+/_-]{24,}={0,2}/g, // long base64, base64url or hex runs
];

export function redact(value: string): string {
  let out = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[redacted]");
  return out;
}

type Level = "info" | "warn" | "error";
export type Logger = Record<Level, (event: string, fields?: LogFields) => void>;

export function createLogger(sink = (line: string) => console.log(line)): Logger {
  const allowed = new Set<string>(LOG_FIELDS);
  const write =
    (level: Level) =>
    (event: string, fields: LogFields = {}) => {
      const entry: Record<string, unknown> = { level, event: redact(event) };
      let dropped = 0;
      for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
        const scalar = ["string", "number", "boolean"].includes(typeof value);
        if (!allowed.has(name) || !scalar) dropped++;
        else entry[name] = typeof value === "string" ? redact(value) : value;
      }
      if (dropped > 0) entry.dropped = dropped;
      sink(JSON.stringify(entry));
    };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

export const log = createLogger();
