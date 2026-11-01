// SPDX-License-Identifier: Apache-2.0
// Activity › Log's helpers (M3-19 AC3, m3-ux §3.8): the request, the kind filter's labels, rows
// grouped by day, and a one-line summary of what changed. The server names each row in plain
// words; these only arrange what it sends.
import { scopeLabel } from "../approvals/copy";

export const LOG_KINDS = [
  ["sign_in", "Sign-ins"],
  ["passkeys", "Passkeys and recovery codes"],
  ["sessions", "Sessions"],
  ["secrets", "Saved keys"],
  ["approvals", "Approvals"],
  ["tools", "Tool settings"],
  ["exports", "Exports"],
  ["deletions", "Deletions"],
  ["settings", "Settings changes"],
] as const;
export type LogKind = (typeof LOG_KINDS)[number][0];

export interface LogEntry {
  id: number;
  at: number;
  kind: LogKind | "other";
  title: string;
  action: string;
  result: string;
  target: string | null;
  detail: unknown;
}

export interface LogPage {
  entries: LogEntry[];
  next: number | null;
  retentionDays: number;
}

export function logQuery(o: { kind?: LogKind | ""; q?: string; before?: number | null }) {
  const params = new URLSearchParams();
  if (o.kind) params.set("kind", o.kind);
  const q = o.q?.trim();
  if (q) params.set("q", q);
  if (o.before != null) params.set("before", String(o.before));
  const s = params.toString();
  return s ? `/api/activity/log?${s}` : "/api/activity/log";
}

export async function fetchLog(o: Parameters<typeof logQuery>[0]): Promise<LogPage> {
  const res = await fetch(logQuery(o));
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as LogPage;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", or the date in the user's locale. */
export function dayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Rows in their order, cut into runs of one local day each. */
export function byDay(entries: LogEntry[], now: number): { day: string; entries: LogEntry[] }[] {
  const groups: { day: string; entries: LogEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayLabel(entry.at, now);
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

const OVERRIDES: Record<string, string> = {
  auto: "Does it without asking",
  ask: "Asks you first",
  never: "Never",
};
const SCOPES = ["once", "task", "hour", "destination"] as const;

const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : String(v));
const isChange = (v: unknown): v is { from: unknown; to: unknown } =>
  typeof v === "object" && v !== null && "from" in v && "to" in v;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** `{ field: { from, to } }` for each field whose value differs between `from` and `to`. */
const pairs = (from: Record<string, unknown>, to: Record<string, unknown>) =>
  Object.fromEntries(
    [...new Set([...Object.keys(from), ...Object.keys(to)])]
      .filter((k) => from[k] !== to[k])
      .map((k) => [k, { from: from[k], to: to[k] }]),
  );

/** A short line under the title: what changed, or the approval's scope; null when nothing adds. */
export function summary(entry: LogEntry): string | null {
  const d = entry.detail;
  if (typeof d !== "object" || d === null) return null;
  const o = d as Record<string, unknown>;
  // A tool's override: its old and new choice (M3-02 AC7); a refused one changed nothing.
  if (entry.action === "policy.override" && isChange(o)) {
    const label = (v: unknown) => (typeof v === "string" && OVERRIDES[v]) || "Default";
    const tool = entry.target ?? "A tool";
    return entry.result === "ok"
      ? `${tool}: ${label(o.from)} → ${label(o.to)}`
      : `${tool}: stayed ${label(o.from)}; ${label(o.to)} was refused`;
  }
  const scope = o.scope;
  if (typeof scope === "string" && (SCOPES as readonly string[]).includes(scope)) {
    return `Scope: ${scopeLabel(scope as (typeof SCOPES)[number])}`;
  }
  // A settings change: each field with its old and new value, or only that it changed. Retention
  // saves the whole setting as `from` and `to`, so its fields are compared one by one.
  const fields = isChange(o) && isRecord(o.from) && isRecord(o.to) ? pairs(o.from, o.to) : o;
  const changes = Object.entries(fields).flatMap(([field, v]) =>
    isChange(v)
      ? [`${field}: ${shown(v.from)} → ${shown(v.to)}`]
      : v === "changed"
        ? [`${field} changed`]
        : [],
  );
  return changes.length ? changes.join("; ") : null;
}

/** The raw record for Details. */
export const rawRecord = (entry: LogEntry) =>
  JSON.stringify(
    {
      action: entry.action,
      result: entry.result,
      target: entry.target,
      at: new Date(entry.at).toISOString(),
      detail: entry.detail,
    },
    null,
    2,
  );
