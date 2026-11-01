#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// `pnpm teardown:cloudflare --name <prefix> [--confirm <prefix>]` (ADR 0001 #7): only verification
// prefixes; lists first (and only lists without `--confirm`); fails if anything is left.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DeployError } from "./deploy-cloudflare.mjs";

// M2 form plus the T3/T4/T7 campaign form `opa-v-q4-<yyyymmdd>-<8hex>` (TWO-669).
export const PREFIX_PATTERN = /^opa-v-(?:[0-9]{8}-[a-z0-9]{6}|q4-[0-9]{8}-[0-9a-f]{8})$/;

// [kind, list path, name field, delete path]: `{p}` is the prefix, `{field}` a field of the item;
// `{page}` lists are followed to the end. Deleting the Worker removes its DOs, cron and assets.
const KINDS = [
  ["worker", "/workers/scripts", "id", "/workers/scripts/{id}?force=true"],
  ["workflow", "/workflows?per_page=100&page={page}", "name", "/workflows/{name}"],
  ["d1", "/d1/database?per_page=100&page={page}&name={p}", "name", "/d1/database/{uuid}"],
  ["r2", "/r2/buckets?per_page=100&name_contains={p}", "name", "/r2/buckets/{name}"],
  ["queue", "/queues", "queue_name", "/queues/{queue_id}"],
];

/** A client for `/accounts/<CLOUDFLARE_ACCOUNT_ID>`. Teardown never guesses the account. */
export function accountApi(deps) {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = deps.env;
  if (!token || !account)
    throw new DeployError("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  const base = `${deps.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"}`;
  return async (p, init = {}) => {
    const headers = { Authorization: `Bearer ${token}` };
    const res = await deps.fetch(`${base}/accounts/${account}${p}`, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok && body.success !== false, body };
  };
}

/** Every resource named the prefix or `<prefix>-…`. M2 has no queues, so no Queues access is fine. */
export async function listPrefixed(api, prefix) {
  const [found, skipped] = [[], []];
  for (const [kind, list, field, remove] of KINDS) {
    for (let page = 1, more = true; more; page++) {
      const res = await api(list.replace("{p}", prefix).replace("{page}", page));
      if (kind === "queue" && (res.status === 401 || res.status === 403)) skipped.push(kind);
      else if (!res.ok) throw new DeployError(`listing ${kind} failed (HTTP ${res.status})`);
      const result = res.body.result ?? [];
      const items = Array.isArray(result) ? result : (result.buckets ?? []);
      more = list.includes("{page}") && items.length === 100;
      for (const item of items) {
        const name = item[field];
        if (name !== prefix && !name?.startsWith(`${prefix}-`)) continue;
        found.push({ kind, name, item, remove: remove.replace(/\{(\w+)\}/, (_m, f) => item[f]) });
      }
    }
  }
  return { found, skipped };
}

export const inventory = async (deps, prefix) =>
  (await listPrefixed(accountApi(deps), prefix)).found;

export async function teardownCloudflare(argv, deps) {
  const { values } = parseArgs({
    args: argv,
    options: { name: { type: "string" }, confirm: { type: "string" } },
  });
  const log = (line = "") => deps.stdout(`${line}\n`);
  const prefix = values.name ?? deps.env.OPA_PREFIX ?? "";
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new DeployError(
      `refusing "${prefix}": teardown only accepts opa-v-<yyyymmdd>-<6 alphanumerics> or opa-v-q4-<yyyymmdd>-<8 hex>`,
    );
  }
  if (values.confirm !== undefined && values.confirm !== prefix) {
    throw new DeployError(`--confirm "${values.confirm}" does not match --name "${prefix}"`);
  }
  const api = accountApi(deps);
  const before = await listPrefixed(api, prefix);
  log(`Resources with prefix "${prefix}" (${before.found.length}):`);
  for (const r of before.found) log(`  ${r.kind}: ${r.name}`);
  for (const kind of before.skipped) log(`  ${kind}: not listed (the token has no access)`);
  if (values.confirm === undefined) {
    log(`Nothing deleted. Re-run with --confirm ${prefix} to delete these.`);
    return { prefix, deleted: [], left: before.found, skipped: before.skipped };
  }

  const deleted = [];
  for (const r of before.found) {
    if (r.kind === "r2") await emptyBucket(api, r.name);
    const res = await api(r.remove, { method: "DELETE" });
    if (res.ok || res.status === 404) deleted.push(`${r.kind}: ${r.name}`);
    else log(`  could not delete ${r.kind} ${r.name} (HTTP ${res.status})`);
  }
  const after = await listPrefixed(api, prefix);
  if (after.found.length) {
    const left = after.found.map((r) => `${r.kind}: ${r.name}`).join("\n  ");
    throw new DeployError(`teardown left resources behind:\n  ${left}`);
  }
  log(`Deleted ${deleted.length}; nothing with prefix "${prefix}" is left.`);
  log("Now delete the API token you used (Cloudflare dashboard → My Profile → API Tokens).");
  return { prefix, deleted, left: [], skipped: after.skipped };
}

// If objects remain anyway, the bucket delete fails and the post-check names the bucket.
async function emptyBucket(api, bucket) {
  const res = await api(`/r2/buckets/${bucket}/objects?per_page=1000`);
  for (const { key } of res.ok ? (res.body.result ?? []) : []) {
    await api(`/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`, { method: "DELETE" });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deps = { env: process.env, fetch, stdout: (t) => process.stdout.write(t) };
  teardownCloudflare(process.argv.slice(2), deps).catch((error) => {
    process.stderr.write(`\n✖ ${error instanceof DeployError ? error.message : error.stack}\n`);
    process.exit(1);
  });
}
