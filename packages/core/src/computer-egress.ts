// SPDX-License-Identifier: Apache-2.0
// The computer SSRF reject set (M4-05 AC3, shared with M4-16 AC5 / M4-18 AC4): the named CIDRs
// computer egress must reject *before* any user allowlist is consulted — RFC 1918, link-local
// 169.254.0.0/16 (metadata included), the host gateway and the LAN. This module is pure and
// portable (no `node:` imports, so the ports lint covers it like `computer-provider.ts`): the
// Worker and Settings UI import the *definition* for display and grey-out reasons, while the
// docker-local adapter (`apps/node/src/docker-local/`) enforces it host-side with firewall
// rules. Dynamic entries (gateway, LAN/host subnets) are appended by the Node side, which is
// why every matcher takes `extraRejects`.

/**
 * The static reject set (M4-05 AC3): RFC 1918 private ranges, link-local (including the cloud
 * metadata address 169.254.169.254), loopback and "this network". The host gateway and the
 * host LAN subnets are dynamic — the Node side appends them per host — because they differ
 * per deployment. IPv6 link-local/unique-local/loopback are rejected too: the computer
 * networks are created without IPv6, so no legitimate computer traffic is IPv6.
 */
export const COMPUTER_EGRESS_STATIC_REJECTS: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
  "0.0.0.0/8",
  "::1/128",
  "fe80::/10",
  "fc00::/7",
  "ff00::/8",
];

/** One named reject entry: what it is, the CIDR, and where it came from. */
export interface EgressRejectEntry {
  /** Stable name M4-16/M4-18 assert on (e.g. `"rfc1918:10/8"`, `"metadata"`, `"host-gateway"`). */
  name: string;
  cidr: string;
  /** `"static"` for the spec set, `"host"` for per-host gateway/LAN entries. */
  source: "static" | "host";
}

const STATIC_NAMES: Record<string, string> = {
  "10.0.0.0/8": "rfc1918:10/8",
  "172.16.0.0/12": "rfc1918:172.16/12",
  "192.168.0.0/16": "rfc1918:192.168/16",
  "169.254.0.0/16": "metadata:link-local",
  "127.0.0.0/8": "loopback",
  "0.0.0.0/8": "this-network",
  "::1/128": "loopback-v6",
  "fe80::/10": "link-local-v6",
  "fc00::/7": "unique-local-v6",
  "ff00::/8": "multicast-v6",
};

/**
 * The full named reject set: the static spec entries plus the host's dynamic ones (gateway,
 * LAN/host subnets, each `{name, cidr}`). Names are stable for M4-16 AC5 / M4-18 AC4.
 */
export function describeRejectSet(
  hostRejects: readonly EgressRejectEntry[] = [],
): EgressRejectEntry[] {
  const statics: EgressRejectEntry[] = COMPUTER_EGRESS_STATIC_REJECTS.map((cidr) => ({
    name: STATIC_NAMES[cidr] ?? cidr,
    cidr,
    source: "static",
  }));
  return [...statics, ...hostRejects];
}

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value >>> 0;
}

function parseIPv6(ip: string): bigint | null {
  // One `::` compression run at most; embedded IPv4 (incl. `::ffff:a.b.c.d`) supported.
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const expand = (side: string): string[] => (side === "" ? [] : side.split(":"));
  const left = expand(halves[0] ?? "");
  const right = halves.length === 2 ? expand(halves[1] ?? "") : [];
  const tail = [...left, ...right];
  const last = tail[tail.length - 1];
  let words: number[] = [];
  let ipv4Tail: number | null = null;
  if (last?.includes(".")) {
    ipv4Tail = parseIPv4(last);
    if (ipv4Tail === null) return null;
    const rest = tail.slice(0, -1);
    if (!rest.every((w) => /^[0-9a-fA-F]{1,4}$/.test(w))) return null;
    words = rest.map((w) => Number.parseInt(w, 16));
    if (halves.length === 2 && words.length > 6) return null;
    if (halves.length === 1 && words.length !== 6) return null;
  } else {
    if (!tail.every((w) => /^[0-9a-fA-F]{1,4}$/.test(w))) return null;
    words = tail.map((w) => Number.parseInt(w, 16));
    if (halves.length === 2 && words.length > 7) return null;
    if (halves.length === 1 && words.length !== 8) return null;
  }
  if (halves.length === 2) {
    const zeros = 8 - words.length - (ipv4Tail === null ? 0 : 2);
    words = [...words, ...new Array<number>(zeros).fill(0)];
  }
  let value = 0n;
  for (const w of words) value = (value << 16n) | BigInt(w);
  if (ipv4Tail !== null) value = (value << 32n) | BigInt(ipv4Tail);
  return value;
}

/** Normalizes an IP literal: unwraps `::ffff:1.2.3.4` to `1.2.3.4`, lowercases IPv6. */
export function normalizeIpLiteral(ip: string): string {
  const trimmed = ip.trim().replace(/^\[(.*)\]$/, "$1");
  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    const tail = trimmed.slice("::ffff:".length);
    if (parseIPv4(tail) !== null) return tail;
  }
  return trimmed.toLowerCase();
}

/** Whether `ip` (a literal) falls inside `cidr`. Unparseable input never matches. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash === -1) return false;
  const base = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isSafeInteger(prefix)) return false;
  const address = normalizeIpLiteral(ip);
  if (base.includes(":")) {
    if (prefix < 0 || prefix > 128) return false;
    const needle = parseIPv6(address);
    const net = parseIPv6(base.toLowerCase());
    if (needle === null || net === null) return false;
    const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
    return (needle & mask) === (net & mask);
  }
  if (prefix < 0 || prefix > 32) return false;
  const needle = parseIPv4(address);
  const net = parseIPv4(base);
  if (needle === null || net === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (needle & mask) === (net & mask);
}

/**
 * Whether an IP literal is in the reject set (M4-05 AC3). Static spec CIDRs always apply;
 * the host's dynamic entries (gateway, LAN) are passed as `extraRejects` CIDRs. Unparseable
 * input fails closed (rejected): the guard must never wave through what it cannot classify.
 */
export function isEgressRejected(ip: string, extraRejects: readonly string[] = []): boolean {
  const address = normalizeIpLiteral(ip);
  const looksIp = parseIPv4(address) !== null || parseIPv6(address) !== null;
  if (!looksIp) return true;
  for (const cidr of COMPUTER_EGRESS_STATIC_REJECTS) {
    if (ipInCidr(address, cidr)) return true;
  }
  for (const cidr of extraRejects) {
    if (ipInCidr(address, cidr)) return true;
  }
  return false;
}

export type EgressDecision = "reject" | "allow" | "deny";

/**
 * The ordering rule, in one place (M4-05 AC3): the reject set is consulted *before* any user
 * allowlist. A rejected IP never reaches the allowlist; an allowed one must still match it;
 * anything else is denied. `allowlist` entries are CIDRs here — hostname allowlists resolve
 * to literals Node-side and arrive as CIDRs, so DNS answers are checked per address.
 */
export function decideEgress(
  ip: string,
  allowlist: readonly string[],
  extraRejects: readonly string[] = [],
): EgressDecision {
  if (isEgressRejected(ip, extraRejects)) return "reject";
  const address = normalizeIpLiteral(ip);
  for (const entry of allowlist) {
    if (ipInCidr(address, entry)) return "allow";
  }
  return "deny";
}

/**
 * Hostname allowlist matching (pure string rules): `example.com` matches itself and any
 * subdomain; anything else must match exactly. Case-insensitive, trailing-dot tolerant.
 */
export function hostMatchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (name.length === 0) return false;
  for (const raw of allowlist) {
    const pattern = raw.trim().toLowerCase().replace(/\.$/, "");
    if (pattern.length === 0) continue;
    if (name === pattern || name.endsWith(`.${pattern}`)) return true;
  }
  return false;
}
