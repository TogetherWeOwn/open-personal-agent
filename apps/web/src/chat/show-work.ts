// SPDX-License-Identifier: Apache-2.0
// The Settings › Assistant › "Show work" choice (M3-09 AC3, m3-ux §3.1): how much of a turn's
// timeline the thread shows.

export type ShowWork = "hidden" | "collapsed" | "expanded";

/** What a thread shows before the user chooses: step rows with their tool cards closed. */
export const SHOW_WORK_DEFAULT: ShowWork = "collapsed";

export const SHOW_WORK_OPTIONS: { value: ShowWork; label: string; detail: string }[] = [
  { value: "hidden", label: "Hidden", detail: "The summary line only." },
  { value: "collapsed", label: "Collapsed", detail: "Step rows show; tool cards stay closed." },
  { value: "expanded", label: "Expanded", detail: "Tool cards open." },
];

/** Reads a stored value, falling back to the default for anything unexpected. */
export function parseShowWork(value: unknown): ShowWork {
  return value === "hidden" || value === "expanded" ? value : SHOW_WORK_DEFAULT;
}
