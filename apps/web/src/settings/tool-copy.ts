// SPDX-License-Identifier: Apache-2.0
// Settings › Apps & tools copy (M3-19 AC1, m3-ux §3.9): the risk class in plain words. Kept
// apart from the page so the copy stays importable (and testable) without the DOM.

export type RiskClass = "read" | "write_reversible" | "consequential" | "irreversible";
export type ToolOverride = "auto" | "ask" | "never" | null;

/** The risk class in plain words (m3-ux §3.9). */
export const riskClassLabel: Record<RiskClass, string> = {
  read: "Reads only",
  write_reversible: "Changes things you can undo",
  consequential: "Sends things out",
  irreversible: "Can't be undone",
};

/**
 * Tool failures in this page's words: the Models copy talks about fields this page has none of.
 * A dismissed passkey prompt rejects with the browser's error, not a server code.
 */
const TOOL_ERRORS: Record<string, string> = {
  floor_irreversible: "This tool can't run without asking — what it does can't be undone.",
  not_found: "That tool isn't available any more. Reload the page and try again.",
  invalid_override: "That choice isn't available for this tool.",
  no_challenge: "Your passkey wasn't confirmed, so nothing changed.",
  not_verified: "Your passkey wasn't confirmed, so nothing changed.",
  unknown: "Your passkey wasn't confirmed, so nothing changed.",
  step_up_required: "Confirm it's you with your passkey first, then try again.",
};

export const toolError = (e: unknown) =>
  (e as Error).name === "NotAllowedError" || (e as Error).name === "AbortError"
    ? "Your passkey wasn't confirmed, so nothing changed."
    : (TOOL_ERRORS[(e as Error).message] ?? "That didn't work. Try again in a moment.");
