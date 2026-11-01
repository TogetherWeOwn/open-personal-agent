// SPDX-License-Identifier: Apache-2.0
// Lint for ADR 0010 D3 and D4.1 #2 over app and package sources (tests are exempt), and D4.1 #4
// over packages/vault/package.json. Runs in `pnpm lint`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE = /^(?:apps|packages)\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/;
const ROOT = /^apps\/worker\/src\/compose\.ts$/; // the composition root
const B = "(?:DB|FILES|ASSISTANT)";

/** [name, allowed paths, pattern, why] */
export const RULES = [
  [
    "raw-binding",
    /^packages\/db\//,
    // env.DB, c.env?.FILES, env["DB"], const { DB } = env, ({ DB }: Env), ({ FILES }) => and
    // Durable Object names
    new RegExp(
      `\\??\\.\\s*${B}\\b|\\[\\s*["'\`]${B}["'\`]\\s*\\]|\\{[^{}]*\\b${B}\\b[^{}]*\\}\\s*(?:=[^=>]|:|\\)\\s*(?:=>|\\{|:))|\\bidFromName\\s*\\(`,
      "g",
    ),
    "use the scoped repository in @opa/db (ADR 0010 D3)",
  ],
  [
    "scope-minting",
    /^(?:packages\/db\/|apps\/[^/]+\/src\/auth\/)/,
    /\bscopeFromSession\b/g,
    "a UserScope comes from the session layer only (ADR 0010 D3)",
  ],
  [
    "master-key",
    /^(?:packages\/vault\/|apps\/worker\/src\/compose\.ts$)/,
    /OPA_MASTER_KEY/g,
    "only packages/vault and the composition root may name it (ADR 0010 D4.1 #2)",
  ],
  [
    "cloudflare-env",
    ROOT,
    /import\s*(?:\{[^}]*\benv\b[^}]*\}|\*\s*as\s+\w+)\s*from\s*["']cloudflare:workers["']/g,
    "only the composition root reads the runtime env (ADR 0010 D4.1 #2)",
  ],
];

/** Violations in [{ path, text }] as "path:line: rule: why". */
export function findViolations(files) {
  return files.flatMap(({ path, text }) =>
    !SOURCE.test(path)
      ? []
      : RULES.flatMap(([name, allowed, pattern, why]) =>
          allowed.test(path)
            ? []
            : [...text.matchAll(pattern)].map((m) => {
                const line = text.slice(0, m.index).split("\n").length;
                return `${path}:${line}: ${name}: ${why}`;
              }),
        ),
  );
}

const VAULT_PACKAGE = "packages/vault/package.json";

/** ADR 0010 D4.1 #4: packages/vault has no runtime dependencies. */
export function findVaultDependencies(packageJson) {
  const pkg = JSON.parse(packageJson);
  return ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
    Object.keys(pkg[field] ?? {}).map(
      (name) => `${VAULT_PACKAGE}: ${field}: ${name}: the vault has none (ADR 0010 D4.1 #4)`,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const paths = execFileSync("git", args, { encoding: "utf8" }).split("\0");
  const files = paths
    .filter((p) => SOURCE.test(p))
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const problems = findViolations(files);
  if (existsSync(VAULT_PACKAGE)) {
    problems.push(...findVaultDependencies(readFileSync(VAULT_PACKAGE, "utf8")));
  }
  for (const p of problems) console.error(p);
  console.log(`scoped-access: ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  if (problems.length > 0) process.exitCode = 1;
}
