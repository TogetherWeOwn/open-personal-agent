// SPDX-License-Identifier: Apache-2.0
// The host-side SSRF firewall (M4-05 AC3): iptables REJECT rules on the DOCKER-USER chain that
// reject the computer reject set — RFC 1918, 169.254.0.0/16 (metadata included), the host
// gateway, the LAN — *before* any user allowlist is consulted. In-computer tests can only
// prove the container sees no route; this is what actually drops the packets on the host.
// REJECT (not DROP) so a blocked probe fails fast and visibly instead of hanging a task.
//
// Ordering inside each per-computer chain: static + host rejects first, then the spec's
// allowlist ACCEPTs, then — only when the spec names an allowlist — a final REJECT. An
// empty allowlist means open-minus-rejects; a non-empty one means closed-to-allowlist.
// The computer networks are IPv4-only, so only the v4 reject CIDRs become rules; there is
// no v6 stack for a computer to exfiltrate over.
//
// Fail-closed: create() applies these rules and throws when iptables is unavailable, so a
// computer never runs unenforced. The docker-gated tests probe the privilege and skip the
// enforcement assertions where the runner cannot program iptables.
import { execFile } from "node:child_process";
import { COMPUTER_EGRESS_STATIC_REJECTS } from "@opa/core";

export interface FirewallRunResult {
  stdout: string;
  stderr: string;
}

/** Runs an `iptables` invocation; injectable so unit tests assert rule order without root. */
export type FirewallRunner = (argv: string[]) => Promise<FirewallRunResult>;

const defaultRunner: FirewallRunner = (argv) =>
  new Promise((resolve, reject) => {
    execFile("iptables", argv, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });

const isIPv4Cidr = (cidr: string): boolean => !cidr.includes(":");

/**
 * The v4 reject CIDRs that become rules: the portable static set plus the host's dynamic
 * entries (gateway, LAN subnets). Pure, so unit tests pin the reject-before-allowlist order
 * and M4-16/M4-18 reuse the names.
 */
export function rejectRuleCidrs(extraRejects: readonly string[] = []): string[] {
  return [...COMPUTER_EGRESS_STATIC_REJECTS.filter(isIPv4Cidr), ...extraRejects.filter(isIPv4Cidr)];
}

export interface ComputerChainOptions {
  /** Per-computer chain, e.g. `opa-c-<12hex>`: iptables caps names at 29 chars. */
  chain: string;
  /** The computer's bridge subnet, e.g. `172.28.0.0/16`. */
  subnet: string;
  /** Resolved-IP ACCEPTs; empty means open-minus-rejects. */
  allowlist: readonly string[];
  /** Host gateway/LAN CIDRs appended after the static set. */
  extraRejects?: readonly string[] | undefined;
}

/**
 * The full rule program for one computer, as `iptables` argv lists in apply order: jump from
 * DOCKER-USER on the computer's subnet first, then the chain body — rejects, allowlist
 * ACCEPTs, and the closing REJECT only when an allowlist was named.
 */
export function buildComputerChainRules(options: ComputerChainOptions): string[][] {
  const extra = options.extraRejects ?? [];
  const rules: string[][] = [
    ["-N", options.chain],
    ["-F", options.chain],
  ];
  for (const cidr of rejectRuleCidrs(extra)) {
    rules.push(["-A", options.chain, "-d", cidr, "-j", "REJECT"]);
  }
  for (const cidr of options.allowlist) {
    if (!isIPv4Cidr(cidr)) continue;
    rules.push(["-A", options.chain, "-d", cidr, "-j", "ACCEPT"]);
  }
  if (options.allowlist.length > 0) {
    rules.push(["-A", options.chain, "-j", "REJECT"]);
  }
  rules.push(["-I", "DOCKER-USER", "1", "-s", options.subnet, "-j", options.chain]);
  return rules;
}

/** Programs the per-computer chain and the DOCKER-USER jump. Throws fail-closed. */
export async function applyComputerFirewall(
  options: ComputerChainOptions,
  run: FirewallRunner = defaultRunner,
): Promise<void> {
  for (const argv of buildComputerChainRules(options)) {
    try {
      await run(argv);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`computer firewall: iptables ${argv.join(" ")} failed: ${detail}`);
    }
  }
}

/** Removes the DOCKER-USER jump and deletes the per-computer chain. Best-effort. */
export async function removeComputerFirewall(
  chain: string,
  subnet: string,
  run: FirewallRunner = defaultRunner,
): Promise<void> {
  const steps: string[][] = [
    ["-D", "DOCKER-USER", "-s", subnet, "-j", chain],
    ["-F", chain],
    ["-X", chain],
  ];
  for (const argv of steps) {
    try {
      await run(argv);
    } catch {
      // Best-effort teardown: the container and network are already gone, and a stale
      // jump to a missing chain falls through DOCKER-USER, never into an open rule.
    }
  }
}

/**
 * Whether this process can program the host firewall. Fails closed with a reason the
 * provider surfaces as `unavailable` instead of running computers unenforced.
 */
export async function probeFirewall(
  run: FirewallRunner = defaultRunner,
): Promise<{ usable: boolean; reason?: string }> {
  try {
    await run(["-L", "DOCKER-USER", "-n"]);
    return { usable: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { usable: false, reason: `iptables DOCKER-USER is not programmable: ${detail}` };
  }
}
