// SPDX-License-Identifier: Apache-2.0
// ADR 0010 D4.1 #3 over the `pnpm deploy:dry-run` bundle: no bundled module except packages/vault
// and the composition root names the master key or imports `env` (or the whole module) from
// "cloudflare:workers". Exceptions go in ALLOWLIST, each with a reviewed reason.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** [{ module: "node_modules/.pnpm/x@1/…/index.js", or a RegExp for peer-hashed dirs, rule, reason }] */
export const ALLOWLIST = [
  {
    module:
      /^node_modules\/\.pnpm\/agents@0\.32\.0_[^/]+\/node_modules\/agents\/dist\/cloudflare-CUUm_9q9\.js$/,
    rule: "cloudflare-env",
    reason: "agents 0.32.0 (M2-13) reads only `tracing` from the module, never `env`",
  },
  {
    module: "node_modules/.pnpm/capnweb@0.12.0/node_modules/capnweb/dist/index-workers.js",
    rule: "cloudflare-env",
    reason: "capnweb 0.12.0 (via agents) reads only the RpcTarget and stub classes, never `env`",
  },
];

const CHECKS = [
  ["master-key", /^(?:packages\/vault\/|apps\/worker\/src\/compose\.ts$)/, /OPA_MASTER_KEY/],
  [
    "cloudflare-env",
    /^apps\/worker\/src\/compose\.ts$/,
    /import\s*(?:\{[^}]*\benv\b[^}]*\}|\*\s*as\s+\w+)\s*from\s*["']cloudflare:workers["']|import\s*\(\s*["']cloudflare:workers["']/,
  ],
];

export function findBundleViolations(bundle, allowlist = ALLOWLIST) {
  // An unminified esbuild bundle starts each module with a `// path/to/module.js` line.
  const modules = bundle.split(/^\/\/ ((?:node_modules|apps|packages)\/\S+)$/m);
  const problems = [];
  for (let i = 1; i < modules.length; i += 2) {
    const [module, code] = [modules[i], modules[i + 1]];
    for (const [rule, own, pattern] of CHECKS) {
      if (own.test(module) || !pattern.test(code)) continue;
      const same = (a) =>
        a.module instanceof RegExp ? a.module.test(module) : a.module === module;
      if (allowlist.some((a) => same(a) && a.rule === rule && a.reason)) continue;
      problems.push(`${module}: ${rule} (ADR 0010 D4.1 #3)`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = findBundleViolations(readFileSync("dist/worker/index.js", "utf8"));
  for (const p of problems) console.error(p);
  console.log(`worker-bundle: ${problems.length === 0 ? "ok" : `${problems.length} problem(s)`}`);
  if (problems.length > 0) process.exitCode = 1;
}
