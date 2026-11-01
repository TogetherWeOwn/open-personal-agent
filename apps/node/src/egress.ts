// SPDX-License-Identifier: Apache-2.0
// The SSRF guard for model-provider calls on Node (ADR 0010 D8). A Worker's fetch can't reach a
// private network; a Node process can, so a user-supplied base URL could read the cloud metadata
// service, the LAN or a localhost admin port. The check runs on the address the socket actually
// connects to, so a DNS answer that changes between check and connect can't slip past it.
import { type LookupAddress, type LookupOptions, lookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

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

/** `dns.lookup` that fails when any address for the host is private. */
function publicLookup(hostname: string, options: LookupOptions, callback: LookupCallback) {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(blockedHost(hostname), []);
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses as [LookupAddress];
    callback(null, first.address, first.family);
  });
}

const blockedHost = (host: string) =>
  Object.assign(new Error(`Model host ${host} is on a private network`), { code: "EBLOCKED" });

/**
 * The fetch model providers use on Node. Unless `allowPrivate` (the operator's
 * `OPA_ALLOW_PRIVATE_MODEL_HOSTS=1`, for a model server on the same machine or LAN), it refuses
 * hosts that resolve to a private, loopback, link-local or metadata address.
 */
export function modelFetch({ allowPrivate }: { allowPrivate: boolean }): typeof fetch {
  if (allowPrivate) return fetch;
  const dispatcher = new Agent({ connect: { lookup: publicLookup } });
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // A literal IP connects without a lookup, so check it here.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host) && isPrivateAddress(host))
      throw new TypeError("fetch failed", {
        cause: blockedHost(host),
      });
    const response = await undiciFetch(input as string, { ...(init as object), dispatcher });
    return response as unknown as Response;
  };
}
