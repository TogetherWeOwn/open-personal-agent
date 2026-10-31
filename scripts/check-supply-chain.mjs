// SPDX-License-Identifier: Apache-2.0
// Supply-chain policy (ADR 0010 D12; R7 M2-9, M2-10): a reviewed build-script allowlist, a
// minimum release age in pnpm and Renovate, and workflows that pin every action by commit SHA,
// default to read-only permissions and never use `pull_request_target`.
import { readdirSync } from "node:fs";
import { isMain, readText, report, repoTextFiles } from "./lib/repo.mjs";

/** Packages whose install scripts were reviewed. Extend only with a reviewed PR. */
export const REVIEWED_BUILDS = ["esbuild", "workerd"];
export const MIN_RELEASE_AGE_MINUTES = 1440;

export function checkPnpmPolicy(workspaceYaml) {
  const problems = [];
  const age = Number(/^minimumReleaseAge:\s*(\d+)\s*$/m.exec(workspaceYaml)?.[1]);
  if (!(age >= MIN_RELEASE_AGE_MINUTES)) {
    problems.push(`pnpm-workspace.yaml: minimumReleaseAge must be >= ${MIN_RELEASE_AGE_MINUTES}`);
  }
  if (!/^strictDepBuilds:\s*true\s*$/m.test(workspaceYaml)) {
    problems.push("pnpm-workspace.yaml: strictDepBuilds must be true");
  }
  const block = /^onlyBuiltDependencies:\s*\n((?:\s+-\s*.+\n?)*)/m.exec(workspaceYaml);
  if (!block) problems.push("pnpm-workspace.yaml: onlyBuiltDependencies allowlist is missing");
  for (const [, name] of block?.[1].matchAll(/-\s*["']?([^"'\s]+)/g) ?? []) {
    if (!REVIEWED_BUILDS.includes(name)) {
      problems.push(`pnpm-workspace.yaml: "${name}" may run build scripts but is not reviewed`);
    }
  }
  return problems;
}

export function checkRenovatePolicy(renovateJson) {
  const config = JSON.parse(renovateJson ?? "{}");
  const rules = [config, ...(config.packageRules ?? [])];
  return rules.some((r) => r.minimumReleaseAge) ? [] : ["renovate.json: no minimumReleaseAge"];
}

export function checkWorkflow(path, yaml) {
  const problems = [];
  if (/\bpull_request_target\b/.test(yaml)) problems.push(`${path}: uses pull_request_target`);
  if (!/^permissions:[ \t]*\n[ \t]+contents:[ \t]*read[ \t]*\n(?![ \t])/m.test(yaml)) {
    problems.push(`${path}: top-level permissions must be exactly "contents: read"`);
  }
  // Any permissions block, job-level included, may narrow access but never grant write.
  for (const m of yaml.matchAll(/^([ \t]*)permissions:(.*)\n((?:\1[ \t]+.*(?:\n|$))*)/gm)) {
    if (/write/.test(m[2] + m[3])) problems.push(`${path}: a permissions block grants write`);
  }
  return [...problems, ...checkPins(path, yaml)];
}

/** Every `uses:` in a workflow or composite action is local or pinned to an immutable ref. */
export function checkPins(path, yaml) {
  const problems = [];
  yaml.split("\n").forEach((line, i) => {
    const value = /^\s*(?:-\s*)?uses:(.*)$/.exec(line)?.[1];
    const ref = value
      ?.replace(/\s#.*$/, "")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (ref === undefined || ref.startsWith("./")) return;
    const pinned = ref.startsWith("docker://")
      ? /@sha256:[0-9a-f]{64}$/.test(ref)
      : /@[0-9a-f]{40}$/.test(ref);
    if (!pinned) problems.push(`${path}:${i + 1}: "${ref}" is not pinned to a full SHA`);
  });
  return problems;
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
    ...actions.flatMap((f) => checkPins(f.path, f.text)),
  ]);
}
