// SPDX-License-Identifier: Apache-2.0
// Context taint (M3-02 AC3, ADR 0005 #6, ADR 0008 #4). The host labels each event that adds content
// to the context from the event's kind, never from anything the model says. Taint is sticky: once a
// turn reads untrusted content it stays tainted, and a promoted task starts from the turn's state.

export type Taint = "trusted" | "untrusted";

/** Memory trust levels, highest first (ADR 0008 #4). */
export type MemoryTrust = "system" | "user" | "inferred" | "external";

/** The `context.tainted` source kinds (M3-03 AC8). */
export type TaintSourceKind = "web" | "file" | "tool";

export type ContextEvent =
  | { kind: "system" | "user_message" | "assistant_message" }
  | { kind: TaintSourceKind; label: string }
  | { kind: "memory"; trust: MemoryTrust; label: string };

/** A turn's taint and what caused it, the first cause first. Plain data, so it can be persisted. */
export type TaintState = {
  taint: Taint;
  sources: readonly { kind: TaintSourceKind | "memory"; label: string }[];
};

export const TRUSTED: TaintState = Object.freeze({ taint: "trusted", sources: Object.freeze([]) });

/**
 * The taint an event brings. Web pages, files and tool results are untrusted. A model reply adds
 * nothing of its own: whatever steered it is already counted. Only system and user memories are
 * trusted; an inferred memory may come from untrusted sources, so it counts as untrusted too.
 */
export function taintOf(event: ContextEvent): Taint {
  switch (event.kind) {
    case "system":
    case "user_message":
    case "assistant_message":
      return "trusted";
    case "memory":
      return event.trust === "system" || event.trust === "user" ? "trusted" : "untrusted";
    default:
      return "untrusted";
  }
}

/** The state after `event` joins the context. It never goes back from untrusted to trusted. */
export function addContext(state: TaintState, event: ContextEvent): TaintState {
  if (taintOf(event) === "trusted" || !("label" in event)) return state;
  return {
    taint: "untrusted",
    sources: [...state.sources, { kind: event.kind, label: event.label }],
  };
}
