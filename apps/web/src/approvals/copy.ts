// SPDX-License-Identifier: Apache-2.0
// What an approval card says (m3-ux §3.3): the action, the rule that fired and the taint reason
// in plain words, never as codes. The rule and the taint reason are separate lines: the rule is
// why it asks, the taint reason is why to be careful.
import type { ApprovalItem } from "@opa/core";

type Scope = ApprovalItem["scopes"][number];

/** Built-in tools' actions as a person would say them; an unknown tool gets its name tidied. */
const ACTIONS: Record<string, string> = {
  web_fetch: "Fetch a page",
  search_history: "Search your chats",
  create_artifact: "Save a file",
  read_file: "Read a file",
  remember: "Remember something",
  forget: "Forget something",
  task: "Start a task",
};

export function actionOf(tool: string): string {
  const known = ACTIONS[tool];
  if (known) return known;
  const words = tool.replace(/[_-]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : tool;
}

/** The policy rule that fired, as the card's **Rule** line. */
export function ruleText(item: ApprovalItem): string {
  const action = actionOf(item.tool);
  switch (item.rule) {
    case "floor_irreversible":
      return "This can't be undone, so I always ask you first and need your passkey.";
    case "floor_tainted_egress":
      return "This sends something out after I read outside content, so I always ask first.";
    case "floor_tainted_consequential":
      return "This acts for you after I read outside content, so I always ask first.";
    case "default_tainted_write":
      return "This changes your data after I read outside content, so I ask first.";
    case "override_ask":
      return `You set ${action} to Asks you first.`;
    case "default_consequential":
      return `${action} acts on your behalf, so it asks you first.`;
    default:
      return "Your settings ask you first for this.";
  }
}

/** The **Why I'm careful** line, only when the context was tainted. */
export function taintText(item: ApprovalItem): string | null {
  const { taint } = item;
  if (!taint) return null;
  const from =
    taint.kind === "web"
      ? `a web page (${taint.label})`
      : taint.kind === "memory"
        ? `a memory I wasn't sure about (${taint.label})`
        : taint.label;
  return `This includes text from ${from}, which could be trying to steer me.`;
}

export const needsPasskey = (item: ApprovalItem) => item.risk === "irreversible";

export function scopeLabel(scope: Scope, target?: string): string {
  switch (scope) {
    case "once":
      return "Just this once";
    case "task":
      return "For this task";
    case "hour":
      return "For 1 hour";
    case "destination":
      return target ? `Always for ${target}` : "Always for this destination";
  }
}

/** Under a standing scope, so it's clear the answer outlasts this one request. */
export const STANDING_NOTE =
  "This keeps applying after this request. You can take it back in Settings › Privacy & security.";

/** "Expires in 23 h", then minutes, then seconds only in the last minute (m3-ux §3.3). */
export function expiresIn(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return "Expired";
  if (ms >= 3_600_000) return `Expires in ${Math.floor(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `Expires in ${Math.floor(ms / 60_000)} min`;
  return `Expires in ${Math.ceil(ms / 1000)} s`;
}

/** The cost line, shown only above $0.10 (M3-07 AC6). */
export function costText(item: ApprovalItem): string | null {
  const micro = item.costMicroUsd;
  if (micro === undefined || micro <= 100_000) return null;
  return `This will cost about $${(micro / 1_000_000).toFixed(2)} (estimate).`;
}

/** What an empty list or object argument reads as, so it never shows as a blank value. */
export function emptyText(value: unknown): string | null {
  if (Array.isArray(value)) return value.length ? null : "(empty list)";
  if (value && typeof value === "object") return Object.keys(value).length ? null : "(empty)";
  return null;
}

/**
 * Characters that render as nothing (zero-width, direction marks and overrides, fillers, variation
 * selectors and tags) that a body or a host could hide; the card shows them as chips.
 */
export const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: each character is matched on its own, as a chip
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** A host that renders as something else: punycode, or letters from more than one script. */
export function looksLikeAnother(host: string): boolean {
  if (/(^|\.)xn--/i.test(host)) return true;
  const latin = /[a-z]/i.test(host);
  return latin && /[^ -\u024f]/.test(host);
}
