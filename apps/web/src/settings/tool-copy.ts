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
