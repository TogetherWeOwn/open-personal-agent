// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  type ApprovalScope,
  decide,
  defaultChoice,
  grantMatches,
  type PolicyInput,
  RISK_CLASSES,
  type RiskClass,
  type StandingGrant,
  type Taint,
  type ToolManifest,
  type ToolOverride,
} from "../src/index";

const NOW = Date.UTC(2026, 10, 1);
const manifest = (riskClass: RiskClass, egress: boolean): ToolManifest => ({
  name: "probe",
  description: "A test tool.",
  inputSchema: { type: "object" },
  riskClass,
  destinations: egress ? [{ id: "web", kind: "third_party", dataEgress: true }] : [],
  scopes: [],
});
const grant: StandingGrant = { tool: "probe", scope: "destination", destination: "example.com" };
// Explicit `undefined`s stand for what a host leaves out.
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
const input = (over: Loose<PolicyInput> = {}): PolicyInput =>
  ({
    manifest: manifest("consequential", false),
    taint: "trusted",
    taskId: "task_1",
    target: "example.com",
    now: NOW,
    ...over,
  }) as PolicyInput;

// Every risk class × override × taint × grant, without and then with egress, in the precedence
// order of M3-02 AC5: `never` > floors > grants > `auto`/`ask` > the SEC-4 default. Written out by
// hand so a change to the engine shows up here. `ask:all` offers once, task, hour and destination.
const TABLE = `
  read             -     trusted   -     | allow default_read                     | allow default_read
  read             -     trusted   grant | allow grant                            | allow grant
  read             -     untrusted -     | allow default_read                     | ask:once floor_tainted_egress
  read             -     untrusted grant | allow grant                            | ask:once floor_tainted_egress
  read             auto  trusted   -     | allow override_auto                    | allow override_auto
  read             auto  trusted   grant | allow grant                            | allow grant
  read             auto  untrusted -     | allow override_auto                    | ask:once floor_tainted_egress
  read             auto  untrusted grant | allow grant                            | ask:once floor_tainted_egress
  read             ask   trusted   -     | ask:all override_ask                   | ask:all override_ask
  read             ask   trusted   grant | allow grant                            | allow grant
  read             ask   untrusted -     | ask:once override_ask                  | ask:once floor_tainted_egress
  read             ask   untrusted grant | allow grant                            | ask:once floor_tainted_egress
  read             never trusted   -     | deny override_never                    | deny override_never
  read             never trusted   grant | deny override_never                    | deny override_never
  read             never untrusted -     | deny override_never                    | deny override_never
  read             never untrusted grant | deny override_never                    | deny override_never
  write_reversible -     trusted   -     | allow default_write_reversible         | allow default_write_reversible
  write_reversible -     trusted   grant | allow grant                            | allow grant
  write_reversible -     untrusted -     | ask:once default_tainted_write         | ask:once floor_tainted_egress
  write_reversible -     untrusted grant | allow grant                            | ask:once floor_tainted_egress
  write_reversible auto  trusted   -     | allow override_auto                    | allow override_auto
  write_reversible auto  trusted   grant | allow grant                            | allow grant
  write_reversible auto  untrusted -     | allow override_auto                    | ask:once floor_tainted_egress
  write_reversible auto  untrusted grant | allow grant                            | ask:once floor_tainted_egress
  write_reversible ask   trusted   -     | ask:all override_ask                   | ask:all override_ask
  write_reversible ask   trusted   grant | allow grant                            | allow grant
  write_reversible ask   untrusted -     | ask:once override_ask                  | ask:once floor_tainted_egress
  write_reversible ask   untrusted grant | allow grant                            | ask:once floor_tainted_egress
  write_reversible never trusted   -     | deny override_never                    | deny override_never
  write_reversible never trusted   grant | deny override_never                    | deny override_never
  write_reversible never untrusted -     | deny override_never                    | deny override_never
  write_reversible never untrusted grant | deny override_never                    | deny override_never
  consequential    -     trusted   -     | ask:all default_consequential          | ask:all default_consequential
  consequential    -     trusted   grant | allow grant                            | allow grant
  consequential    -     untrusted -     | ask:once floor_tainted_consequential   | ask:once floor_tainted_consequential
  consequential    -     untrusted grant | ask:once floor_tainted_consequential   | ask:once floor_tainted_consequential
  consequential    auto  trusted   -     | allow override_auto                    | allow override_auto
  consequential    auto  trusted   grant | allow grant                            | allow grant
  consequential    auto  untrusted -     | ask:once floor_tainted_consequential   | ask:once floor_tainted_consequential
  consequential    auto  untrusted grant | ask:once floor_tainted_consequential   | ask:once floor_tainted_consequential
  consequential    ask   trusted   -     | ask:all override_ask                   | ask:all override_ask
  consequential    ask   trusted   grant | allow grant                            | allow grant
  consequential    ask   untrusted -     | ask:once floor_tainted_consequential   | ask:once floor_tainted_consequential
  consequential    ask   untrusted grant | ask:once floor_tainted_consequential   | ask:once floor_tainted_consequential
  consequential    never trusted   -     | deny override_never                    | deny override_never
  consequential    never trusted   grant | deny override_never                    | deny override_never
  consequential    never untrusted -     | deny override_never                    | deny override_never
  consequential    never untrusted grant | deny override_never                    | deny override_never
  irreversible     -     trusted   -     | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     -     trusted   grant | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     -     untrusted -     | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     -     untrusted grant | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     auto  trusted   -     | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     auto  trusted   grant | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     auto  untrusted -     | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     auto  untrusted grant | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     ask   trusted   -     | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     ask   trusted   grant | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     ask   untrusted -     | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     ask   untrusted grant | ask+stepup:once floor_irreversible     | ask+stepup:once floor_irreversible
  irreversible     never trusted   -     | deny override_never                    | deny override_never
  irreversible     never trusted   grant | deny override_never                    | deny override_never
  irreversible     never untrusted -     | deny override_never                    | deny override_never
  irreversible     never untrusted grant | deny override_never                    | deny override_never
`;

const rows = TABLE.trim()
  .split("\n")
  .flatMap((line) => {
    const [when = "", ...thens] = line.split("|").map((s) => s.trim());
    const [risk, override, taint, hasGrant] = when.split(/\s+/);
    return thens.map((then, i) => {
      const [result = "", rule] = then.split(" ");
      const egress = i === 1;
      const name = `${when} ${egress ? "egress" : "-"} → ${then}`;
      return { name, risk, override, taint, hasGrant, egress, result, rule };
    });
  });

describe("decide", () => {
  it("has exactly one table row for each combination", () => {
    const keys = rows.map((r) => [r.risk, r.override, r.taint, r.hasGrant, r.egress].join(" "));
    expect(keys.length).toBe(4 * 4 * 2 * 2 * 2);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(rows.map((r) => r.risk))).toEqual(new Set(RISK_CLASSES));
  });

  it.each(rows)("$name", (row) => {
    const d = decide(
      input({
        manifest: manifest(row.risk as RiskClass, row.egress),
        taint: row.taint as Taint,
        override: row.override === "-" ? undefined : (row.override as ToolOverride),
        grants: row.hasGrant === "grant" ? [grant] : [],
      }),
    );
    const [outcome, scopes] = row.result.split(":");
    expect(d.rule).toBe(row.rule);
    expect(d.risk).toBe(row.risk);
    if (outcome === "allow" || outcome === "deny") {
      expect(d.outcome).toBe(outcome);
      return;
    }
    if (d.outcome !== "ask") throw new Error(`expected ask, got ${d.outcome}`);
    expect(d.stepUp).toBe(outcome === "ask+stepup");
    const all: ApprovalScope[] = ["once", "task", "hour", "destination"];
    expect(d.scopes).toEqual(scopes === "all" ? all : ["once"]);
  });

  it("offers task and destination scopes only when the call has them", () => {
    const d = decide(input({ taskId: undefined, target: undefined }));
    expect(d.outcome === "ask" && d.scopes).toEqual(["once", "hour"]);
  });

  it("treats a call led by an untrusted skill as tainted", () => {
    const skill = { source: "url", sha256: "a".repeat(64), trust: "untrusted" as const };
    const d = decide(input({ manifest: manifest("read", true), skill }));
    expect(d).toMatchObject({ outcome: "ask", rule: "floor_tainted_egress", taint: "untrusted" });
    expect(decide(input({ skill: { ...skill, trust: "trusted" } })).taint).toBe("trusted");
  });

  it("counts only destinations that declare egress", () => {
    const memory = { id: "memory", kind: "control_plane", dataEgress: false } as const;
    const local = { ...manifest("read", false), destinations: [memory] };
    expect(decide(input({ manifest: local, taint: "untrusted" }))).toMatchObject({
      outcome: "allow",
      egress: false,
    });
  });
});

describe("defaultChoice", () => {
  it("mirrors the decide defaults: reads and reversible writes run, the rest ask", () => {
    expect(defaultChoice("read")).toBe("auto");
    expect(defaultChoice("write_reversible")).toBe("auto");
    expect(defaultChoice("consequential")).toBe("ask");
    expect(defaultChoice("irreversible")).toBe("ask");
  });
});

describe("grantMatches", () => {
  const task = { tool: "probe", scope: "task", taskId: "task_1" } as const;
  const hour = { tool: "probe", scope: "hour", expiresAt: NOW + 1 } as const;
  it.each<[string, Loose<StandingGrant>, Loose<PolicyInput>, boolean]>([
    ["a destination grant for its target", grant, {}, true],
    ["another tool's grant", { ...grant, tool: "other" }, {}, false],
    ["a destination grant for another target", grant, { target: "evil.example" }, false],
    ["a destination grant with no target", grant, { target: undefined }, false],
    ["a task grant in its task", task, {}, true],
    ["a task grant in another task", task, { taskId: "task_2" }, false],
    ["a task grant outside any task", task, { taskId: undefined }, false],
    [
      "a taskless grant outside any task",
      { ...task, taskId: undefined },
      { taskId: undefined },
      false,
    ],
    ["an hour grant before it expires", hour, {}, true],
    ["an hour grant once it expires", { ...hour, expiresAt: NOW }, {}, false],
    ["an hour grant with no expiry", { ...hour, expiresAt: undefined }, {}, false],
    ["a grant with an unknown scope", { ...grant, scope: "forever" as never }, {}, false],
  ])("%s: %s", (_, g, over, matches) => {
    expect(grantMatches(g as StandingGrant, input(over))).toBe(matches);
  });
});
