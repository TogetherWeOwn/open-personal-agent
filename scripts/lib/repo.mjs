// SPDX-License-Identifier: Apache-2.0
// Shared helpers for the scripts/check-*.mjs CI guards.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Reads a file as UTF-8 text, or returns null for binary or missing files. */
export function readText(path) {
  try {
    const buf = readFileSync(path);
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch {
    return null;
  }
}

// JSONC comments and trailing commas; group 1 keeps string literals intact.
const JSONC_NOISE = /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[}\]])/g;
/** Parses JSONC such as wrangler.jsonc. */
export const parseJsonc = (text) => JSON.parse(text.replace(JSONC_NOISE, (_m, s) => s ?? ""));

/** Text files git knows about (tracked plus untracked, minus ignored) as [{ path, text }]. */
export function repoTextFiles() {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const paths = new Set(execFileSync("git", args, { encoding: "utf8" }).split("\0"));
  return [...paths].flatMap((path) => {
    const text = path ? readText(path) : null;
    return text === null ? [] : [{ path, text }];
  });
}

/** True when the calling module is the script node was started with. */
export const isMain = (url) =>
  process.argv[1] !== undefined && url === pathToFileURL(process.argv[1]).href;

/** Prints the problems and sets a failing exit code if there are any. */
export function report(check, problems) {
  if (problems.length === 0) return console.log(`${check}: ok`);
  console.error(`${check}: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exitCode = 1;
}
