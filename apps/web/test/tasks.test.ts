// SPDX-License-Identifier: Apache-2.0
// The Tasks view's helpers (M3-13 AC1-2): the now/history split, the Paused: limit mapping,
// and the cost and elapsed labels.
import { describe, expect, it } from "vitest";
import {
  addPage,
  costLabel,
  elapsed,
  HISTORY_STATUSES,
  isExecutionLimitKind,
  isInFlight,
  listQuery,
  money,
  NOW_STATUSES,
  type TaskItem,
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
    expect(query.has("until")).toBe(false);
  });

  it("keeps the statuses on every page", () => {
    const query = new URLSearchParams(listQuery(HISTORY_STATUSES, 1_700_000_000_000));
    expect(query.getAll("status").sort()).toEqual([...HISTORY_STATUSES].sort());
    expect(query.get("until")).toBe("1700000000000");
    expect(query.get("limit")).toBe("100");
  });
});

describe("History paging (TWO-713)", () => {
  const task = (id: string, createdAt: number) => ({ id, createdAt }) as TaskItem;
  const ids = (tasks: TaskItem[]) => tasks.map((t) => t.id);

  it("ends on a short page", () => {
    const pages = addPage([], [task("a", 30), task("b", 20)], 3);
    expect(ids(pages.tasks)).toEqual(["a", "b"]);
    expect(pages.until).toBeNull();
  });

  it("continues from the oldest row and drops the rows it repeats", () => {
    const first = addPage([], [task("a", 30), task("b", 20), task("c", 20)], 3);
    expect(first.until).toBe(20);
    // `until` is inclusive: the next page starts with the rows at 20 again, in any order.
    const second = addPage(first.tasks, [task("c", 20), task("d", 20), task("b", 20)], 3);
    expect(ids(second.tasks)).toEqual(["a", "b", "c", "d"]);
    expect(second.until).toBe(20);
    const third = addPage(second.tasks, [task("d", 20), task("e", 10)], 3);
    expect(ids(third.tasks)).toEqual(["a", "b", "c", "d", "e"]);
    expect(third.until).toBeNull();
  });

  it("steps past a millisecond that holds more than a page", () => {
    const first = addPage([], [task("a", 20), task("b", 20)], 2);
    const stuck = addPage(first.tasks, [task("b", 20), task("a", 20)], 2);
    expect(ids(stuck.tasks)).toEqual(["a", "b"]);
    expect(stuck.until).toBe(19);
  });

  it("ends on an empty page", () => {
    expect(addPage([task("a", 1)], [], 2)).toEqual({ tasks: [task("a", 1)], until: null });
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
    expect(costLabel({ calls: 1, costMicroUsd: null, unpricedCalls: 0 })).toBe(
      "1 call · cost unknown",
    );
    expect(costLabel({ calls: 3, costMicroUsd: 123_400, unpricedCalls: 0 })).toBe(
      "3 calls · $0.12",
    );
  });

  it("names the unpriced calls the subtotal is missing", () => {
    expect(costLabel({ calls: 3, costMicroUsd: 123_400, unpricedCalls: 2 })).toBe(
      "3 calls · $0.12 · 2 unpriced",
    );
    expect(costLabel({ calls: 1, costMicroUsd: null, unpricedCalls: 1 })).toBe(
      "1 call · cost unknown · 1 unpriced",
    );
  });
});

describe("the elapsed label", () => {
  it("stays quiet before the start, then counts in s, m and h", () => {
    expect(
      elapsed({ startedAt: null, finishedAt: null, status: "queued", updatedAt: 0 }),
    ).toBeNull();
    expect(
      elapsed({ startedAt: 1_000, finishedAt: 46_000, status: "succeeded", updatedAt: 46_000 }),
    ).toBe("45s");
    expect(
      elapsed({ startedAt: 1_000, finishedAt: 193_000, status: "failed", updatedAt: 193_000 }),
    ).toBe("3m 12s");
    expect(
      elapsed({ startedAt: 0, finishedAt: 7_500_000, status: "cancelled", updatedAt: 7_500_000 }),
    ).toBe("2h 5m");
  });

  it("counts a running task to now", () => {
    expect(
      elapsed({ startedAt: 1_000, finishedAt: null, status: "running", updatedAt: 2_000 }, 61_000),
    ).toBe("1m 0s");
  });

  it("freezes a paused task at its last write instead of counting idle time", () => {
    // Paused at 301s; an hour later the clock still reads the five run minutes.
    expect(
      elapsed(
        { startedAt: 1_000, finishedAt: null, status: "budget_limited", updatedAt: 301_000 },
        3_901_000,
      ),
    ).toBe("5m 0s");
  });
});

describe("the task title", () => {
  it("falls back when the title is missing or blank", () => {
    expect(taskTitle({ title: "Summarise the thread" })).toBe("Summarise the thread");
    expect(taskTitle({ title: null })).toBe("Untitled task");
    expect(taskTitle({ title: "   " })).toBe("Untitled task");
  });
});
