// SPDX-License-Identifier: Apache-2.0
// Supply-chain policy (ADR 0010 D12; R7 M2-9, M2-10): a reviewed build-script allowlist, a
// minimum release age in pnpm and Renovate, and workflows that pin every action by commit SHA,
// default to read-only permissions and never use `pull_request_target`. Also ADR 0010 D4.1 #8:
// every third-party package the Worker can bundle is on a reviewed list.

import { readdirSync } from "node:fs";
import { posix } from "node:path";
import { parse } from "yaml";
import { isMain, readText, report, repoTextFiles } from "./lib/repo.mjs";

/** Packages whose install scripts were reviewed. Extend only with a reviewed PR. */
export const REVIEWED_BUILDS = ["esbuild", "workerd"];
export const MIN_RELEASE_AGE_MINUTES = 1440;

/**
 * Third-party packages in the Worker's runtime dependency closure (D4.1 #8). Any of them can read
 * `OPA_MASTER_KEY` at runtime (D4 residual risk), so a PR that extends this list needs a Security
 * Engineer review stage. Version bumps don't; a new package, direct or transitive, does.
 */
export const REVIEWED_RUNTIME = ["@cloudflare/workers-types", "drizzle-orm", "hono"];
export const WORKER_IMPORTER = "apps/worker";

/** Every third-party package `apps/worker` reaches through `dependencies`, from pnpm-lock.yaml. */
export function runtimeClosure(lockYaml, importer = WORKER_IMPORTER) {
  const lock = parse(lockYaml) ?? {};
  const seen = new Set();
  const names = new Set();
  // An alias (`npm:other@1`) is recorded as the full `other@1` key.
  const keyOf = (name, version) =>
    version.split("(")[0].includes("@") ? version : `${name}@${version}`;
  const visitPackage = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    names.add(key.slice(0, key.indexOf("@", 1)));
    const snap = lock.snapshots?.[key] ?? {};
    for (const [name, version] of Object.entries({
      ...snap.dependencies,
      ...snap.optionalDependencies,
    })) {
      visitPackage(keyOf(name, version));
    }
  };
  const visitImporter = (dir) => {
    if (seen.has(`link:${dir}`)) return;
    seen.add(`link:${dir}`);
    // Workspace packages are bundled too, so their dependencies count. Optional ones are installed.
    const importerDeps = lock.importers?.[dir] ?? {};
    for (const [name, { version }] of Object.entries({
      ...importerDeps.dependencies,
      ...importerDeps.optionalDependencies,
    })) {
      if (version.startsWith("link:")) visitImporter(posix.join(dir, version.slice(5)));
      else visitPackage(keyOf(name, version));
    }
  };
  visitImporter(importer);
  return [...names].sort();
}

export function checkRuntimeDependencies(lockYaml) {
  if (lockYaml == null) {
    return ["pnpm-lock.yaml: missing, so the Worker's runtime dependencies can't be checked"];
  }
  return runtimeClosure(lockYaml)
    .filter((name) => !REVIEWED_RUNTIME.includes(name))
    .map(
      (name) =>
        `pnpm-lock.yaml: "${name}" is bundled into the Worker unreviewed; add it to ` +
        "REVIEWED_RUNTIME with a Security Engineer review (ADR 0010 D4.1 #8)",
    );
}

export function checkPnpmPolicy(workspaceYaml) {
  const ws = parse(workspaceYaml) ?? {};
  const builds = ws.onlyBuiltDependencies;
  return [
    !(ws.minimumReleaseAge >= MIN_RELEASE_AGE_MINUTES) &&
      `minimumReleaseAge must be >= ${MIN_RELEASE_AGE_MINUTES}`,
    ws.strictDepBuilds !== true && "strictDepBuilds must be true",
    !Array.isArray(builds) && "the onlyBuiltDependencies allowlist is missing",
    ...(builds ?? []).map(
      (n) => !REVIEWED_BUILDS.includes(n) && `"${n}" may run build scripts unreviewed`,
    ),
  ]
    .filter(Boolean)
    .map((p) => `pnpm-workspace.yaml: ${p}`);
}

export function checkRenovatePolicy(renovateJson) {
  const config = JSON.parse(renovateJson ?? "{}");
  const rules = [config, ...(config.packageRules ?? [])];
  return rules.some((r) => r.minimumReleaseAge) ? [] : ["renovate.json: no minimumReleaseAge"];
}

const grantsWrite = (perms) =>
  typeof perms === "string"
    ? perms.includes("write")
    : Object.values(perms ?? {}).includes("write");

export function checkWorkflow(path, text) {
  const wf = parse(text) ?? {};
  const problems = [];
  const on = wf.on ?? {};
  const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on);
  if (triggers.includes("pull_request_target")) problems.push(`${path}: uses pull_request_target`);
  if (JSON.stringify(wf.permissions) !== '{"contents":"read"}') {
    problems.push(`${path}: top-level permissions must be exactly "contents: read"`);
  }
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    if (grantsWrite(job?.permissions)) problems.push(`${path}: job "${name}" grants write`);
  }
  return [...problems, ...checkPins(path, wf)];
}

/** Every `uses:` in a parsed workflow or composite action is local or pinned to an immutable ref. */
export function checkPins(path, doc) {
  const refs = (node, at) =>
    node && typeof node === "object"
      ? Object.entries(node).flatMap(([k, v]) =>
          k === "uses" ? [[at, String(v)]] : refs(v, at ? `${at}.${k}` : k),
        )
      : [];
  return refs(doc, "")
    .filter(([, ref]) => !ref.startsWith("./"))
    .filter(([, ref]) =>
      ref.startsWith("docker://")
        ? !/@sha256:[0-9a-f]{64}$/.test(ref)
        : !/@[0-9a-f]{40}$/.test(ref),
    )
    .map(([at, ref]) => `${path}: ${at} uses "${ref}", which is not pinned to a full SHA`);
}

if (isMain(import.meta.url)) {
  const dir = ".github/workflows";
  const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const actions = repoTextFiles().filter((f) =>
    /^\.github\/actions\/.+\/action\.ya?ml$/.test(f.path),
  );
  report("supply-chain", [
    ...checkPnpmPolicy(readText("pnpm-workspace.yaml") ?? ""),
    ...checkRenovatePolicy(readText("renovate.json")),
    ...checkRuntimeDependencies(readText("pnpm-lock.yaml")),
    ...workflows.flatMap((f) => checkWorkflow(`${dir}/${f}`, readText(`${dir}/${f}`) ?? "")),
    ...actions.flatMap((f) => checkPins(f.path, parse(f.text))),
  ]);
}
