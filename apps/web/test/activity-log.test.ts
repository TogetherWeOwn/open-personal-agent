// SPDX-License-Identifier: Apache-2.0
// Activity › Log's helpers (M3-19 AC3): the request, day groups, and the summary line.
import { describe, expect, it } from "vitest";
import { byDay, dayLabel, type LogEntry, logQuery, rawRecord, summary } from "../src/activity/log";

const entry = (o: Partial<LogEntry>): LogEntry => ({
  id: 1,
  at: Date.now(),
  kind: "other",
  title: "Something",
  action: "something",
  result: "ok",
  target: null,
  detail: null,
  ...o,
});

describe("logQuery", () => {
  it("sends only what is set, with the search trimmed and encoded", () => {
    expect(logQuery({})).toBe("/api/activity/log");
    expect(logQuery({ kind: "", q: "  " })).toBe("/api/activity/log");
    expect(logQuery({ kind: "approvals", q: " send & mail ", before: 42 })).toBe(
      "/api/activity/log?kind=approvals&q=send+%26+mail&before=42",
    );
  });
});

describe("day groups", () => {
  const now = new Date(2026, 10, 1, 15).getTime();
  const hour = 3_600_000;

  it("labels today and yesterday by the local day, and older days by date", () => {
    expect(dayLabel(now - hour, now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 31, 23, 59).getTime(), now)).toBe("Yesterday");
    const older = dayLabel(new Date(2026, 9, 20, 12).getTime(), now);
    expect(older).toMatch(/20/);
    expect(older).not.toMatch(/2026/);
    expect(dayLabel(new Date(2025, 9, 20, 12).getTime(), now)).toMatch(/2025/);
  });

  it("keeps the order and starts a group at each new day", () => {
    const rows = [
      entry({ id: 4, at: now - hour }),
      entry({ id: 3, at: now - 2 * hour }),
      entry({ id: 2, at: now - 24 * hour }),
      entry({ id: 1, at: now - 30 * 24 * hour }),
    ];
    const groups = byDay(rows, now);
    expect(groups.map((g) => [g.day, g.entries.map((e) => e.id)])).toEqual([
      ["Today", [4, 3]],
      ["Yesterday", [2]],
      [groups[2]?.day, [1]],
    ]);
  });
});

describe("summary", () => {
  it("shows a tool's old and new choice in the Settings words", () => {
    const override = entry({
      action: "policy.override",
      target: "send_email",
      detail: { tool: "send_email", from: "ask", to: "auto", riskClass: "egress" },
    });
    expect(summary(override)).toBe("send_email: Asks you first → Does it without asking");
    const cleared = entry({ ...override, detail: { from: "never", to: null } });
    expect(summary(cleared)).toBe("send_email: Never → Default");
  });

  it("shows an approval's scope", () => {
    const approved = entry({ action: "approval.approve", detail: { scope: "hour" } });
    expect(summary(approved)).toBe("Scope: For 1 hour");
    expect(summary(entry({ detail: { scope: null } }))).toBeNull();
  });

  it("lists each changed setting, and only names a private one", () => {
    expect(
      summary(
        entry({
          detail: {
            dailyCapMicroUsd: { from: 5_000_000, to: 100_000_000 },
            hardCapMicroUsd: { from: null, to: 30_000_000 },
            about: "changed",
          },
        }),
      ),
    ).toBe(
      "dailyCapMicroUsd: 5000000 → 100000000; hardCapMicroUsd: none → 30000000; about changed",
    );
  });

  it("adds nothing for a plain string or an object without changes", () => {
    expect(summary(entry({ detail: "model_key" }))).toBeNull();
    expect(summary(entry({ detail: { reason: "denied_at_recheck" } }))).toBeNull();
  });
});

describe("rawRecord", () => {
  it("is the stored record, readable, with an ISO time", () => {
    const at = Date.UTC(2026, 10, 1, 12);
    const text = rawRecord(
      entry({ at, action: "auth.login", result: "denied", target: null, detail: null }),
    );
    expect(JSON.parse(text)).toEqual({
      action: "auth.login",
      result: "denied",
      target: null,
      at: "2026-11-01T12:00:00.000Z",
      detail: null,
    });
  });
});
