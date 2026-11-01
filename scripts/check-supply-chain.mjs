// SPDX-License-Identifier: Apache-2.0
// Supply-chain policy (ADR 0010 D12; R7 M2-9, M2-10): a reviewed build-script allowlist, a
// minimum release age in pnpm and Renovate, and workflows that pin every action by commit SHA,
// default to read-only permissions and never use `pull_request_target`. Also ADR 0010 D4.1 #8:
// every third-party package in the Worker bundle is on a reviewed list.

import { readdirSync } from "node:fs";
import { parse } from "yaml";
import { isMain, readText, report, repoTextFiles } from "./lib/repo.mjs";

/** Packages whose install scripts were reviewed. Extend only with a reviewed PR. */
export const REVIEWED_BUILDS = ["esbuild", "workerd"];
export const MIN_RELEASE_AGE_MINUTES = 1440;

/**
 * Third-party packages the Worker bundle contains (D4.1 #8). Any of them can read
 * `OPA_MASTER_KEY` at runtime (D4 residual risk), so a PR that extends this list needs a Security
 * Engineer review stage. Version bumps don't; a new package, direct or transitive, does.
 */
export const REVIEWED_RUNTIME = [
  "@cloudflare/workers-types",
  "drizzle-orm",
  "hono",
  // @simplewebauthn/server (M2-09) and its closure. No install scripts; only the library's MDS
  // and CRL helpers call `fetch`, and nothing in the closure reads env or evals.
  "@hexagon/base64",
  "@levischuck/tiny-cbor",
  "@peculiar/asn1-android",
  "@peculiar/asn1-asym-key",
  "@peculiar/asn1-cms",
  "@peculiar/asn1-csr",
  "@peculiar/asn1-ecc",
  "@peculiar/asn1-pfx",
  "@peculiar/asn1-pkcs8",
  "@peculiar/asn1-pkcs9",
  "@peculiar/asn1-rsa",
  "@peculiar/asn1-schema",
  "@peculiar/asn1-x509",
  "@peculiar/asn1-x509-attr",
  "@peculiar/asn1-x509-post-quantum",
  "@peculiar/utils",
  "@peculiar/x509",
  "@simplewebauthn/server",
  "asn1js",
  "pvtsutils",
  "pvutils",
  "reflect-metadata",
  "tslib",
  "tsyringe",
  // agents@0.32.0 (M2-13) and what of it the bundle contains.
  "@babel/runtime-corejs3",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/core",
  "agents",
  "capnweb",
  "core-js-pure",
  "cron-schedule",
  "eventsource",
  "eventsource-parser",
  "jose",
  "mime-db",
  "mime-types",
  "mimetext",
  "nanoid",
  "pkce-challenge",
  "zod",
];

/** esbuild's metafile for the Worker bundle, written by `pnpm deploy:dry-run`. */
export const WORKER_METAFILE = "dist/worker-meta.json";

/**
 * Every third-party package the Worker bundle contains, from the `inputs` of its esbuild metafile.
 * Not from the lockfile: pnpm records a package's optional peers (agents' vite, rolldown, babel,
 * esbuild, react) as snapshot dependencies, so a lockfile walk counts build tools that never ship.
 * The metafile lists only the files esbuild actually bundled.
 */
export function bundledPackages(metafileJson) {
  const names = new Set();
  for (const input of Object.keys(JSON.parse(metafileJson).inputs ?? {})) {
    const at = input.lastIndexOf("node_modules/");
    if (at >= 0) {
      const [scope, name] = input.slice(at + "node_modules/".length).split("/");
      names.add(scope.startsWith("@") ? `${scope}/${name}` : scope);
    } else if (!/^(apps|packages)\/|^node-built-in-modules:/.test(input)) {
      // Bundled from outside node_modules and the workspace: nothing can review that by name.
      names.add(input);
    }
  }
  return [...names].sort();
}

export function checkRuntimeDependencies(metafileJson) {
  if (metafileJson == null) {
    return [
      `${WORKER_METAFILE}: missing, so the Worker's bundled packages can't be checked; ` +
        "run `pnpm deploy:dry-run` first",
    ];
  }
  return bundledPackages(metafileJson)
    .filter((name) => !REVIEWED_RUNTIME.includes(name))
    .map(
      (name) =>
        `${WORKER_METAFILE}: "${name}" is bundled into the Worker unreviewed; add it to ` +
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
    ...checkRuntimeDependencies(readText(WORKER_METAFILE)),
    ...workflows.flatMap((f) => checkWorkflow(`${dir}/${f}`, readText(`${dir}/${f}`) ?? "")),
    ...actions.flatMap((f) => checkPins(f.path, parse(f.text))),
  ]);
}
