// SPDX-License-Identifier: Apache-2.0
// Two lint rules tsc and Biome do not cover:
// - Ports rule (ADR 0011 #4): only the composition roots (apps/worker, apps/node) may import
//   Cloudflare runtime modules, the Agents SDK or Node built-ins. Shared packages, the web app and
//   the Worker modules apps/node loads through `@opa/worker` stay runtime-agnostic.
// - Dependency guard: test, build and agent tooling belongs in devDependencies, never in the
//   `dependencies` that ship.
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path";
import { isMain, report, repoTextFiles } from "./lib/repo.mjs";

const PORTABLE_SOURCES = /^(?:packages\/[^/]+|apps\/web)\/src\/.*\.(?:[cm]?[jt]sx?)$/;
const NODE_BUILTINS = new Set(builtinModules);
const TYPE_ONLY = /\b(?:import|export)\s+type\s[^;]*?\bfrom\s*["'][^"']+["']/g;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

export const isRuntimeSpecific = (specifier) =>
  /^(?:cloudflare:|node:|agents(?:\/|$))/.test(specifier) ||
  NODE_BUILTINS.has(specifier.split("/")[0]);

/** The Worker modules `@opa/worker`'s exports load, following relative imports. */
export function sharedWorkerSources(files) {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const exports = JSON.parse(byPath.get("apps/worker/package.json") ?? "{}").exports ?? {};
  const pending = Object.values(exports).map((p) => join("apps/worker", p));
  const seen = new Set();
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    // `import type` is erased at runtime, so Node never loads its target.
    const text = (byPath.get(path) ?? "").replace(TYPE_ONLY, "");
    for (const { 1: specifier } of text.matchAll(SPECIFIER)) {
      if (!specifier.startsWith(".")) continue;
      const base = normalize(join(dirname(path), specifier)).replace(/\.js$/, "");
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) =>
        byPath.has(c),
      );
      if (found) pending.push(found);
    }
  }
  return seen;
}

/** Imports of runtime-specific modules from portable sources. */
export function findPortViolations(files) {
  const shared = sharedWorkerSources(files);
  const problems = [];
  for (const { path, text } of files) {
    if (!PORTABLE_SOURCES.test(path) && !shared.has(path)) continue;
    for (const { 1: specifier, index } of text.matchAll(SPECIFIER)) {
      if (!isRuntimeSpecific(specifier)) continue;
      const line = text.slice(0, index).split("\n").length; // whole-text match: multi-line imports
      problems.push(`${path}:${line}: imports "${specifier}" (ports rule, ADR 0011 #4)`);
    }
  }
  return problems;
}

const TOOLING =
  /^(?:@?vitest|@playwright|playwright|wrangler|miniflare|typescript|vite|msw|jest|eslint|drizzle-kit)(?:\/|$)|^@(?:biomejs|vitejs|types)\/|^@cloudflare\/(?:vitest-plugin|workers-types)$|^@anthropic-ai\/claude-|^@openai\/codex$/;

/** Tooling listed under `dependencies` in any workspace package.json. */
export function findDependencyViolations(manifests) {
  const problems = [];
  for (const { path, text } of manifests) {
    for (const name of Object.keys(JSON.parse(text).dependencies ?? {})) {
      if (TOOLING.test(name)) {
        problems.push(`${path}: "${name}" is tooling; move it to devDependencies`);
      }
    }
  }
  return problems;
}

if (isMain(import.meta.url)) {
  const files = repoTextFiles();
  const manifests = files.filter(({ path }) => /(?:^|\/)package\.json$/.test(path));
  report("ports-rule", findPortViolations(files));
  report("dependency-guard", findDependencyViolations(manifests));
}
