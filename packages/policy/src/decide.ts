// SPDX-License-Identifier: Apache-2.0
// The policy decision for one tool call (M3-02 AC2, AC4, AC5; ADR 0010 D6, D9). A pure function:
// the host reads the override and grants, and fails closed if it can't (ADR 0010 D1). Precedence:
// `never` > floors > grants > `auto`/`ask` > the SEC-4 default for the risk class.
import { hasEgress, type RiskClass, type ToolManifest } from "./manifest";
import type { Taint } from "./taint";

/** The user's per-tool setting (EL fix 9). No override means the SEC-4 default. */
export type ToolOverride = "auto" | "ask" | "never";

/** How long an approval holds: this call, this task, an hour, or always for this destination. */
export type ApprovalScope = "once" | "task" | "hour" | "destination";

/** A standing grant (its table ships in M3-02b). Created only from an untainted context. */
export type StandingGrant = {
  tool: string;
  scope: "task" | "hour" | "destination";
  taskId?: string; // scope "task"
  destination?: string; // scope "destination": the call's target, e.g. a host
  expiresAt?: number; // epoch ms; scope "hour"
};

/** Skill provenance (ADR 0009 #6). Skills ship in M5; an active untrusted skill taints the call. */
export type SkillTrust = { source: string; sha256: string; trust: "trusted" | "untrusted" };

export type PolicyInput = {
  manifest: ToolManifest;
  taint: Taint;
  override?: ToolOverride;
  grants?: readonly StandingGrant[]; // the user's grants for this tool
  taskId?: string; // the task the call runs in, if any
  target?: string; // what the call reaches, e.g. a URL's host
  skill?: SkillTrust; // the skill whose instructions led to the call, if any
  now: number; // epoch ms
};

/** Why the engine decided as it did; shown on the approval card and written to the audit log. */
export type PolicyRule =
  | "override_never"
  | "floor_irreversible"
  | "floor_tainted_consequential"
  | "floor_tainted_egress"
  | "grant"
  | "override_auto"
  | "override_ask"
  | "default_read"
  | "default_write_reversible"
  | "default_tainted_write"
  | "default_consequential";

type Common = { rule: PolicyRule; risk: RiskClass; taint: Taint; egress: boolean };
export type PolicyDecision =
  | (Common & { outcome: "allow" | "deny" })
  | (Common & { outcome: "ask"; stepUp: boolean; scopes: readonly ApprovalScope[] });

const RANK: Record<RiskClass, number> = {
  read: 0,
  write_reversible: 1,
  consequential: 2,
  irreversible: 3,
};

export function grantMatches(grant: StandingGrant, input: PolicyInput): boolean {
  if (grant.tool !== input.manifest.name) return false;
  switch (grant.scope) {
    case "task":
      return grant.taskId !== undefined && grant.taskId === input.taskId;
    case "hour":
      return grant.expiresAt !== undefined && input.now < grant.expiresAt;
    case "destination":
      return grant.destination !== undefined && grant.destination === input.target;
    default:
      return false; // an unknown scope never matches (fail closed)
  }
}

/**
 * The choice an untouched tool behaves as, for Settings › Apps & tools (M3-19 AC1): reads and
 * reversible writes run; anything with outside effects, or that can't be undone, asks first.
 * Mirrors the `default_*` arms of `decide` below — a tainted turn can still ask on top, which
 * the page's "still asks first" note says.
 */
export function defaultChoice(risk: RiskClass): "auto" | "ask" {
  return risk === "read" || risk === "write_reversible" ? "auto" : "ask";
}

export function decide(input: PolicyInput): PolicyDecision {
  const risk = input.manifest.riskClass;
  const egress = hasEgress(input.manifest);
  const taint: Taint =
    input.taint === "trusted" && (input.skill === undefined || input.skill.trust === "trusted")
      ? "trusted"
      : "untrusted";
  const tainted = taint === "untrusted";
  const common = { risk, taint, egress };
  const allow = (rule: PolicyRule): PolicyDecision => ({ ...common, outcome: "allow", rule });
  // From a tainted context the card offers only "Just this once" (AC4), because standing grants
  // are created only from an untainted context (AC2). An irreversible call always asks again.
  const ask = (rule: PolicyRule, stepUp = false): PolicyDecision => ({
    ...common,
    outcome: "ask",
    rule,
    stepUp,
    scopes:
      tainted || stepUp
        ? ["once"]
        : [
            "once",
            ...(input.taskId === undefined ? [] : (["task"] as const)),
            "hour",
            ...(input.target === undefined ? [] : (["destination"] as const)),
          ],
  });

  if (input.override === "never") return { ...common, outcome: "deny", rule: "override_never" };

  // Floors: no grant and no override lifts them (AC2).
  if (risk === "irreversible") return ask("floor_irreversible", true);
  if (tainted && RANK[risk] >= RANK.consequential) return ask("floor_tainted_consequential");
  if (tainted && egress) return ask("floor_tainted_egress");

  if (input.grants?.some((g) => grantMatches(g, input))) return allow("grant");
  if (input.override === "auto") return allow("override_auto");
  if (input.override === "ask") return ask("override_ask");

  switch (risk) {
    case "read":
      return allow("default_read");
    case "write_reversible":
      return tainted ? ask("default_tainted_write") : allow("default_write_reversible");
    default:
      return ask("default_consequential");
  }
}
