// SPDX-License-Identifier: Apache-2.0
// Fails if $OPA_CANARY, plain or base64, is in any given file or directory (R7 M2-5+). `--log`
// names the test suite's console output, which must also hold the app's request log: an empty
// capture would pass without testing anything.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { canaryForms } from "./canary-forms.mjs";

export function findCanary(files, canary) {
  if (!canary || canary.length < 16) return ["OPA_CANARY is unset or shorter than 16 characters"];
  const forms = canaryForms(canary);
  return files
    .filter(({ text }) => forms.some((f) => text.includes(f)))
    .map(({ path }) => `${path}: contains the canary`);
}

const walk = (path) =>
  statSync(path).isDirectory()
    ? readdirSync(path, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
    : [path];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const log = args[0] === "--log" ? args.splice(0, 2)[1] : undefined;
  const files = [log, ...args]
    .filter(Boolean)
    .flatMap(walk)
    .map((path) => ({ path, text: readFileSync(path, "latin1") }));
  const problems = findCanary(files, process.env.OPA_CANARY);
  if (log && !readFileSync(log, "utf8").includes('"event":"request"'))
    problems.push(`${log}: no request log, so the console wasn't captured`);
  for (const p of problems) console.error(p);
  console.log(`canary-scan: ${problems.length === 0 ? `ok (${files.length} files)` : "failed"}`);
  if (problems.length > 0) process.exitCode = 1;
}
