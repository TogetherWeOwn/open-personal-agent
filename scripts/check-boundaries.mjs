// SPDX-License-Identifier: Apache-2.0
// Three lint rules tsc and Biome do not cover:
// - Ports rule (ADR 0011 #4): only the composition roots (apps/worker, apps/node) may import
//   Cloudflare runtime modules, the Agents SDK or Node built-ins. Shared packages, the HTTP app in
//   packages/server included, and the web app stay runtime-agnostic, even in types.
// - App-to-app rule (TWO-435 A9): no app imports another app's code or depends on its package.
//   Code two apps share belongs in packages/*.
// - Dependency guard: test, build and agent tooling belongs in devDependencies, never in the
//   `dependencies` that ship.
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path/posix"; // git's paths, on Windows too
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

const APP_PATH = /^apps\/([^/]+)\//;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies"];
const packageOf = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

/** Imports (types too) and dependencies from one app on another, in sources and tests. */
export function findAppImports(files) {
  const apps = new Map(); // package name -> its directory under apps/
  for (const { path, text } of files) {
    const dir = /^apps\/([^/]+)\/package\.json$/.exec(path)?.[1];
    if (dir) apps.set(JSON.parse(text).name, dir);
  }
  const problems = [];
  const flag = (where, specifier, own, target) => {
    if (target && target !== own) {
      problems.push(`${where}: "${specifier}" is apps/${target}; share it from packages/*`);
    }
  };
  for (const { path, text } of files) {
    const own = APP_PATH.exec(path)?.[1];
    if (!own) continue;
    if (path === `apps/${own}/package.json`) {
      const pkg = JSON.parse(text);
      for (const field of DEPENDENCY_FIELDS) {
        for (const name of Object.keys(pkg[field] ?? {})) flag(path, name, own, apps.get(name));
      }
      continue;
    }
    if (!SOURCE.test(path)) continue;
    for (const { 1: specifier, index } of text.matchAll(SPECIFIER)) {
      // `?raw` reads a file's text, such as the SPA's `_headers` a test checks; it loads no code.
      if (specifier.endsWith("?raw")) continue;
      const target = specifier.startsWith(".")
        ? APP_PATH.exec(normalize(join(dirname(path), specifier)))?.[1]
        : apps.get(packageOf(specifier));
      flag(`${path}:${text.slice(0, index).split("\n").length}`, specifier, own, target);
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
  report("app-to-app", findAppImports(files));
  report("dependency-guard", findDependencyViolations(manifests));
}
