// SPDX-License-Identifier: Apache-2.0
// Builder independence (PRD §17): the product must not import, link to or read the environment of
// the tools it was built with. Scans every file in the repo, including the lockfile, so a
// denylisted import, URL, env name or transitive dependency fails CI.
// The patterns are written so they do not match their own source text.
import { isMain, report, repoTextFiles } from "./lib/repo.mjs";

export const DENYLIST = [
  /paper[c]lip/i,
  /cli[-_ ]?pro[x]y/i,
  /hind[s]ight/i,
  // Claude Code and the Claude Agent SDK are installed by the user, never bundled (ADR 0011 #2).
  /@anthropic-ai\/claude-(?:code|agent-sdk)\b/i,
  /\bCLAUDE_[C]ODE_[A-Z0-9_]*/,
];

/** Returns "path:line: matches /pattern/" for every denylisted match in the given files. */
export function findViolations(files) {
  const problems = [];
  for (const { path, text } of files) {
    for (const pattern of DENYLIST) {
      if (pattern.test(path)) problems.push(`${path}: path matches ${pattern}`);
    }
    text.split("\n").forEach((line, i) => {
      for (const pattern of DENYLIST) {
        if (pattern.test(line)) problems.push(`${path}:${i + 1}: matches ${pattern}`);
      }
    });
  }
  return problems;
}

if (isMain(import.meta.url)) {
  report("builder-independence", findViolations(repoTextFiles()));
}
