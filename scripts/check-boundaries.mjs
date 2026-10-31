// SPDX-License-Identifier: Apache-2.0
// Two lint rules tsc and Biome do not cover:
// - Ports rule (ADR 0011 #4): only the composition roots (apps/worker, apps/node) may import
//   Cloudflare runtime modules, the Agents SDK or Node built-ins. Shared packages and the web app
//   stay runtime-agnostic and depend on ports.
// - Dependency guard: test, build and agent tooling belongs in devDependencies, never in the
//   `dependencies` that ship.
import { builtinModules } from "node:module";
import { isMain, report, repoTextFiles } from "./lib/repo.mjs";

const PORTABLE_SOURCES = /^(?:packages\/[^/]+|apps\/web)\/src\/.*\.(?:[cm]?[jt]sx?)$/;
const NODE_BUILTINS = new Set(builtinModules);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

export const isRuntimeSpecific = (specifier) =>
  /^(?:cloudflare:|node:|agents(?:\/|$))/.test(specifier) ||
  NODE_BUILTINS.has(specifier.split("/")[0]);

/** Imports of runtime-specific modules from portable sources. */
export function findPortViolations(files) {
  const problems = [];
  for (const { path, text } of files) {
    if (!PORTABLE_SOURCES.test(path)) continue;
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
