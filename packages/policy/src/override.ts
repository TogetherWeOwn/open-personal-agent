// SPDX-License-Identifier: Apache-2.0
// Changing a tool's override (M3-02 AC7): a change towards `auto` loosens it and needs the 5-minute
// account step-up; a change towards `never` tightens it and needs nothing.
import type { ToolOverride } from "./decide";
import type { RiskClass } from "./manifest";

/**
 * How much a setting lets a tool of `risk` run without asking, before the floors. No override is
 * the SEC-4 default: it runs reads, and reversible writes unless the context is tainted, so for a
 * reversible write it sits between `ask` and `auto`.
 */
function looseness(risk: RiskClass, override: ToolOverride | null): number {
  if (override === "never") return 0;
  if (override === "ask") return 1;
  if (override === "auto") return 3;
  return risk === "read" ? 3 : risk === "write_reversible" ? 2 : 1;
}

/** Whether moving a tool of `risk` from `from` to `to` is any change towards `auto`. */
export const loosens = (risk: RiskClass, from: ToolOverride | null, to: ToolOverride | null) =>
  looseness(risk, to) > looseness(risk, from);
