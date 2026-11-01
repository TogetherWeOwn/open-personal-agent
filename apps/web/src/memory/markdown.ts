// SPDX-License-Identifier: Apache-2.0
// "What my assistant knows about me" as Markdown (M3-15 AC4). Pure, so it is unit-tested.
import { type Note, sourceLabel } from "./api";

const TRUST = {
  system: "built in",
  user: "you told me",
  inferred: "I worked this out",
  external: "from a web page or file",
};

/** One bullet per note; Markdown in a note's own text is shown as typed, never as formatting. */
export function knowsMarkdown(notes: Note[]) {
  const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });
  const plain = (text: string) => text.replace(/([\\`*_[\]{}()#+\-.!<>|~])/g, "\\$1");
  const bullets = (list: Note[]) =>
    list.length === 0
      ? "_Nothing yet._"
      : list
          .map(
            (n) =>
              `- ${plain(n.text.replace(/\s+/g, " "))} _(${TRUST[n.trust]}; ${plain(sourceLabel(n))}; ${day(n.createdAt)})_`,
          )
          .join("\n");
  return [
    "## About you",
    bullets(notes.filter((n) => n.kind === "instruction")),
    "## Notes",
    bullets(notes.filter((n) => n.kind === "fact")),
  ].join("\n\n");
}
