// SPDX-License-Identifier: Apache-2.0
// The Tasks view's helpers (M3-13 AC1-2): the now/history split, the Paused: limit mapping,
// and the cost and elapsed labels.
import { describe, expect, it } from "vitest";
import {
  costLabel,
  elapsed,
  HISTORY_STATUSES,
  isExecutionLimitKind,
  isInFlight,
  listQuery,
  money,
  NOW_STATUSES,
  type TaskStatus,
  taskTitle,
} from "../src/tasks/tasks";

const STATUSES: TaskStatus[] = [
  "queued",
  "running",
  "waiting_for_approval",
  "budget_limited",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

describe("the now/history split", () => {
  it("partitions every status exactly once", () => {
    expect([...NOW_STATUSES, ...HISTORY_STATUSES].sort()).toEqual([...STATUSES].sort());
  });

  it("reads queued, working, waiting and paused as in flight", () => {
    for (const status of NOW_STATUSES) expect(isInFlight(status)).toBe(true);
    for (const status of HISTORY_STATUSES) expect(isInFlight(status)).toBe(false);
  });

  it("fetches each tab by its statuses", () => {
    const query = new URLSearchParams(listQuery(NOW_STATUSES));
    expect(query.getAll("status").sort()).toEqual([...NOW_STATUSES].sort());
    expect(query.get("limit")).toBe("100");
  });
});

describe("the Paused: limit mapping", () => {
  it("reads execution limits as limits, and money or the unknown as budget", () => {
    for (const kind of ["calls", "tools", "tool_rate", "steps", "duration"]) {
      expect(isExecutionLimitKind(kind)).toBe(true);
    }
    for (const kind of ["task_budget", "daily", "monthly_hard", null, "something-new"]) {
      expect(isExecutionLimitKind(kind)).toBe(false);
    }
  });
});

describe("the cost label", () => {
  it("never shows a non-zero cost as $0.00, and says when the cost is unknown", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(1)).toContain("<");
    expect(money(123_400)).toBe("$0.12");
    expect(costLabel({ calls: 1, costMicroUsd: null })).toBe("1 call · cost unknown");
    expect(costLabel({ calls: 3, costMicroUsd: 123_400 })).toBe("3 calls · $0.12");
  });
});

describe("the elapsed label", () => {
  it("stays quiet before the start, then counts in s, m and h", () => {
    expect(elapsed({ startedAt: null, finishedAt: null })).toBeNull();
    expect(elapsed({ startedAt: 1_000, finishedAt: 46_000 })).toBe("45s");
    expect(elapsed({ startedAt: 1_000, finishedAt: 193_000 })).toBe("3m 12s");
    expect(elapsed({ startedAt: 0, finishedAt: 7_500_000 })).toBe("2h 5m");
  });

  it("counts a running task to now", () => {
    expect(elapsed({ startedAt: 1_000, finishedAt: null }, 61_000)).toBe("1m 0s");
  });
});

describe("the task title", () => {
  it("falls back when the title is missing or blank", () => {
    expect(taskTitle({ title: "Summarise the thread" })).toBe("Summarise the thread");
    expect(taskTitle({ title: null })).toBe("Untitled task");
    expect(taskTitle({ title: "   " })).toBe("Untitled task");
  });
});
