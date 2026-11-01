// SPDX-License-Identifier: Apache-2.0
// The Tasks view's data and formatting (M3-13 AC1-2): the row shape the API returns, which
// statuses read as now versus history, and how a `budget_limited` stop maps to its chip. The
// web never imports the server's row types: the API returns plain JSON, so these mirror it.

import type { Status } from "../ui";

/** Every status a task row can hold (M3-13 AC1): the chip kit's vocabulary. */
export type TaskStatus = Status;

/** One Tasks row with its conversation and spend so far, as `GET /api/tasks` returns it. */
export interface TaskItem {
  id: string;
  title: string | null;
  conversationId: string;
  conversationTitle: string | null;
  kind: string;
  mode: string;
  status: TaskStatus;
  limitKind: string | null;
  error: string | null;
  costMicroUsd: number | null;
  calls: number;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** Still has a future: queued, working, waiting on the user, or paused. */
export const NOW_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "waiting_for_approval",
  "budget_limited",
];

/** Over, one way or another. */
export const HISTORY_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

export const isInFlight = (status: TaskStatus): boolean =>
  (NOW_STATUSES as readonly string[]).includes(status);

/**
 * A `budget_limited` stop by one of these reads "Paused: limit", never "budget": the run hit
 * an execution limit (steps, time, calls, tool use), not money. Unknown and null kinds read
 * as budget, the safer assumption when the server can't say.
 */
export function isExecutionLimitKind(kind: string | null): boolean {
  return (
    kind === "calls" ||
    kind === "tools" ||
    kind === "tool_rate" ||
    kind === "steps" ||
    kind === "duration"
  );
}

/** The query string for a `GET /api/tasks` fetch over these statuses. */
export function listQuery(statuses: readonly TaskStatus[], limit = 100): string {
  const params = new URLSearchParams();
  for (const status of statuses) params.append("status", status);
  params.set("limit", String(limit));
  return params.toString();
}

/** Never shows a non-zero cost as $0.00. Costs are micro USD, as the field says. */
export function money(micro: number): string {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
  return micro > 0 && micro < 10_000 ? `< ${fmt.format(0.01)}` : fmt.format(micro / 1e6);
}

export function costLabel(task: Pick<TaskItem, "costMicroUsd" | "calls">): string {
  const calls = `${task.calls} ${task.calls === 1 ? "call" : "calls"}`;
  return task.costMicroUsd === null
    ? `${calls} · cost unknown`
    : `${calls} · ${money(task.costMicroUsd)}`;
}

/** "3m 12s" between start and finish (or now, while running); null before it starts. */
export function elapsed(
  task: Pick<TaskItem, "startedAt" | "finishedAt">,
  now: number = Date.now(),
): string | null {
  if (task.startedAt === null) return null;
  const seconds = Math.max(0, Math.floor(((task.finishedAt ?? now) - task.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export const taskTitle = (task: Pick<TaskItem, "title">): string =>
  task.title?.trim() ? task.title : "Untitled task";

export function startedLabel(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
