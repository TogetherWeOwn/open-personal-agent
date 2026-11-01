// SPDX-License-Identifier: Apache-2.0
// The SSRF guard for model-provider calls on Node (ADR 0010 D8). A Worker's fetch can't reach a
// private network; a Node process can, so a user-supplied base URL could read the cloud metadata
// service, the LAN or a localhost admin port. The check runs on every connection, redirects
// included, and on the address the socket actually connects to, so a DNS answer that changes
// between check and connect can't slip past it.
import { type LookupAddress, type LookupOptions, lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, buildConnector, type RequestInit, fetch as undiciFetch } from "undici";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast and reserved, through 255.255.255.255
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 127], // unspecified and loopback
  ["64:ff9b::", 96], // NAT64 can map to a private IPv4 address
  ["fc00::", 7], // unique local, including fd00:ec2::254
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/**
 * Whether `address` is loopback, private, link-local, metadata or otherwise not public. `BlockList`
 * checks an IPv4-mapped IPv6 address against the IPv4 ranges.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) throw new TypeError(`Not an IP address: ${address}`);
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
type IsBlocked = (address: string) => boolean;
/** Why an address is refused, or null when it may be reached. */
type Refuse = (address: string) => string | null;

/** `dns.lookup` that fails when any address for the host is refused. */
const guardedLookup =
  (refuse: Refuse) => (hostname: string, options: LookupOptions, callback: LookupCallback) =>
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const reason = addresses.length === 0 ? "unresolved" : first(addresses, refuse);
      if (reason) return callback(blockedHost(hostname, reason), []);
      if (options.all) return callback(null, addresses);
      const [address] = addresses as [LookupAddress];
      callback(null, address.address, address.family);
    });

const first = (addresses: LookupAddress[], refuse: Refuse) =>
  addresses.map((a) => refuse(a.address)).find((reason) => reason !== null) ?? null;

const blockedHost = (host: string, reason: string) =>
  Object.assign(new Error(`Host ${host} is ${reason}`), { code: "EBLOCKED" });

/**
 * The fetch model providers use on Node. Unless `allowPrivate` (the operator's
 * `OPA_ALLOW_PRIVATE_MODEL_HOSTS=1`, for a model server on the same machine or LAN), it refuses
 * hosts that resolve to a private, loopback, link-local or metadata address. Plain HTTP reaches
 * private addresses only, so a key never crosses the internet unencrypted. `isBlocked` is for
 * tests.
 */
export function modelFetch({
  allowPrivate,
  isBlocked = isPrivateAddress,
}: {
  allowPrivate: boolean;
  isBlocked?: IsBlocked;
}): typeof fetch {
  const refuse =
    (plain: boolean): Refuse =>
    (address) => {
      if (isBlocked(address)) return allowPrivate ? null : "on a private network";
      return plain ? "public, so it needs https" : null;
    };
  return guardedFetch(refuse(false), refuse(true));
}

/**
 * The fetch `web_fetch` uses on Node (M3-08 AC1): the same SSRF guard, for model-chosen URLs.
 * There is no `allowPrivate` here — the operator's model-host allowance names servers they run,
 * and a page the model picks is never one of them. Plain HTTP is allowed, as it is on Workers:
 * the request carries no key and no cookies, and the tool re-checks every redirect itself.
 */
export function pageFetch({
  isBlocked = isPrivateAddress,
}: {
  isBlocked?: IsBlocked;
} = {}): typeof fetch {
  const refuse: Refuse = (address) => (isBlocked(address) ? "on a private network" : null);
  return guardedFetch(refuse, refuse);
}

function guardedFetch(refuseTls: Refuse, refusePlain: Refuse): typeof fetch {
  const tls = buildConnector({ lookup: guardedLookup(refuseTls) });
  const plain = buildConnector({ lookup: guardedLookup(refusePlain) });
  const dispatcher = new Agent({
    // Every connection, including each redirect hop. A literal IP connects without a lookup.
    connect(options, callback) {
      const isPlain = options.protocol === "http:";
      const host = options.hostname.replace(/^\[(.*)\]$/, "$1");
      const reason = isIP(host) ? (isPlain ? refusePlain : refuseTls)(host) : null;
      if (reason) return callback(blockedHost(host, reason), null);
      return (isPlain ? plain : tls)(options, callback);
    },
  });
  return async (input, init) => {
    // undici's fetch can't read Node's built-in Request, so pass its parts. The body is read into
    // memory (model requests are small JSON) so a 307 or 308 redirect can resend it.
    const request = new Request(input, init);
    const { method, headers, redirect, signal } = request;
    const body = request.body && (await request.arrayBuffer());
    const options = { method, headers, body, redirect, signal, dispatcher };
    return (await undiciFetch(
      request.url,
      options as unknown as RequestInit,
    )) as unknown as Response;
  };
}
