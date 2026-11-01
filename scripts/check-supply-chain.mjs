// SPDX-License-Identifier: Apache-2.0
// Supply-chain policy (ADR 0010 D12; R7 M2-9, M2-10): a reviewed build-script allowlist, a
// minimum release age in pnpm and Renovate, and workflows that pin every action by commit SHA,
// default to read-only permissions and never use `pull_request_target`.
import { readdirSync } from "node:fs";
import { parse } from "yaml";
import { isMain, readText, report, repoTextFiles } from "./lib/repo.mjs";

/** Packages whose install scripts were reviewed. Extend only with a reviewed PR. */
export const REVIEWED_BUILDS = ["esbuild", "workerd"];
export const MIN_RELEASE_AGE_MINUTES = 1440;

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
    ...workflows.flatMap((f) => checkWorkflow(`${dir}/${f}`, readText(`${dir}/${f}`) ?? "")),
    ...actions.flatMap((f) => checkPins(f.path, parse(f.text))),
  ]);
}
