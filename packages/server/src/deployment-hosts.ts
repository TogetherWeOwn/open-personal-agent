// SPDX-License-Identifier: Apache-2.0
// The deployment's own hostnames on Workers: `web_fetch` refuses them, so a page can't make a
// turn read the app itself. No deploy path sets `OPA_OWN_HOSTS` (the deploy button asks only
// for the three `OPA_*` secrets), so the Worker learns them instead: setup POSTs and the
// session touch record the request URL's host, and both turn hosts — the Assistant DO and the
// task Workflow — read the recorded set unioned with `OPA_OWN_HOSTS`, which stays as a manual
// override/addition. Any hostname that reaches the store genuinely routed to this deployment
// (Cloudflare routes by it; it can't be spoofed through the Worker), and a wrong entry only
// ever refuses a fetch, never allows one — fail-closed. Reads degrade to the env var alone,
// which is today's behavior, so a D1 hiccup never fails a turn.
import { systemStore } from "@opa/db/system";
import type { AppPorts } from "./env";
import { parseOwnHosts } from "./turn-tools";

/** What `resolveOwnHosts` reads: the D1 the store runs on, plus the manual override. */
export type OwnHostsEnv = Pick<AppPorts, "DB" | "OPA_OWN_HOSTS">;

/**
 * The request URL's host in the form the store keeps it (lowercase, no trailing dot), or
 * `null` when the URL doesn't parse or names no host. The URL parser normalizes capitals and
 * IDNA exactly as it does for fetched URLs, so the recorded form compares equal later.
 */
export function hostnameOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (!host || host.length > 253) return null;
  return host;
}

/**
 * Remembers that `url`'s host serves this deployment. Best-effort by the caller's choice: it
 * rejects when the write does, so request paths catch it — recording must never fail the
 * request it rides on. First sighting keeps its time; every sighting refreshes the last.
 */
export function noteDeploymentHost(
  env: OwnHostsEnv,
  url: string,
  now: number = Date.now(),
): Promise<void> {
  const hostname = hostnameOf(url);
  if (!hostname) return Promise.resolve();
  return systemStore(env).deploymentHosts.record(hostname, now);
}

/**
 * The hostnames `web_fetch` must refuse for this deployment: `OPA_OWN_HOSTS` first, then every
 * recorded serving hostname, deduplicated case-insensitively. A store read that fails resolves
 * to the env var alone rather than failing the turn.
 */
export async function resolveOwnHosts(env: OwnHostsEnv): Promise<string[]> {
  const configured = parseOwnHosts(env.OPA_OWN_HOSTS);
  const recorded = await systemStore(env)
    .deploymentHosts.list()
    .catch(() => [] as string[]);
  const seen = new Set(configured.map((h) => h.toLowerCase()));
  const hosts = [...configured];
  for (const host of recorded) {
    const key = host.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hosts.push(host);
    }
  }
  return hosts;
}
