// SPDX-License-Identifier: Apache-2.0
// M4-05 AC3 coverage: the named reject set, literal matching, reject-before-allowlist
// ordering, hostname allowlist rules, and fail-closed unparseable input.
import { describe, expect, it } from "vitest";
import {
  COMPUTER_EGRESS_STATIC_REJECTS,
  decideEgress,
  describeRejectSet,
  hostMatchesAllowlist,
  ipInCidr,
  isEgressRejected,
  normalizeIpLiteral,
} from "../src/computer-egress";

describe("COMPUTER_EGRESS_STATIC_REJECTS", () => {
  it("names RFC 1918, link-local/metadata, loopback and IPv6 locals", () => {
    expect(COMPUTER_EGRESS_STATIC_REJECTS).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "::1/128",
        "fe80::/10",
        "fc00::/7",
      ]),
    );
  });

  it("describes stable names for the M4-16/M4-18 reject set", () => {
    const names = new Map(describeRejectSet().map((entry) => [entry.cidr, entry.name]));
    expect(names.get("10.0.0.0/8")).toBe("rfc1918:10/8");
    expect(names.get("172.16.0.0/12")).toBe("rfc1918:172.16/12");
    expect(names.get("192.168.0.0/16")).toBe("rfc1918:192.168/16");
    expect(names.get("169.254.0.0/16")).toBe("metadata:link-local");
    expect(describeRejectSet().every((entry) => entry.source === "static")).toBe(true);
  });

  it("appends host gateway/LAN entries after the static set", () => {
    const set = describeRejectSet([
      { name: "host-gateway", cidr: "172.24.0.1/32", source: "host" },
      { name: "host-lan:enp6s0", cidr: "5.135.138.0/24", source: "host" },
    ]);
    expect(
      set.slice(0, COMPUTER_EGRESS_STATIC_REJECTS.length).every((e) => e.source === "static"),
    ).toBe(true);
    expect(set.at(-2)).toEqual({ name: "host-gateway", cidr: "172.24.0.1/32", source: "host" });
    expect(set.at(-1)).toEqual({ name: "host-lan:enp6s0", cidr: "5.135.138.0/24", source: "host" });
  });
});

describe("ipInCidr", () => {
  it.each([
    ["10.1.2.3", "10.0.0.0/8"],
    ["172.16.0.1", "172.16.0.0/12"],
    ["172.31.255.255", "172.16.0.0/12"],
    ["192.168.0.1", "192.168.0.0/16"],
    ["169.254.169.254", "169.254.0.0/16"],
    ["127.0.0.1", "127.0.0.0/8"],
    ["::1", "::1/128"],
    ["fe80::1", "fe80::/10"],
    ["fd00:ec2::254", "fc00::/7"],
    ["ff02::1", "ff00::/8"],
  ])("matches %s in %s", (ip, cidr) => expect(ipInCidr(ip, cidr)).toBe(true));

  it.each([
    ["172.32.0.1", "172.16.0.0/12"],
    ["11.0.0.1", "10.0.0.0/8"],
    ["1.1.1.1", "169.254.0.0/16"],
    ["8.8.8.8", "192.168.0.0/16"],
    ["::2", "::1/128"],
    ["2001:db8::1", "fc00::/7"],
    ["not-an-ip", "10.0.0.0/8"],
    ["10.0.0.1", "not-a-cidr"],
    ["10.0.0.1", "10.0.0.0/33"],
  ])("does not match %s in %s", (ip, cidr) => expect(ipInCidr(ip, cidr)).toBe(false));

  it("unwraps IPv4-mapped IPv6", () => {
    expect(normalizeIpLiteral("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(ipInCidr("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true);
  });
});

describe("isEgressRejected", () => {
  it.each(["10.0.0.5", "172.20.1.1", "192.168.1.1", "169.254.169.254", "127.0.0.1", "::1"])(
    "rejects %s by default",
    (ip) => expect(isEgressRejected(ip)).toBe(true),
  );

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "140.82.121.4", "2606:4700:4700::1111"])(
    "passes %s by default",
    (ip) => expect(isEgressRejected(ip)).toBe(false),
  );

  it("rejects the host gateway and LAN when the host appends them", () => {
    const extra = ["172.24.0.1/32", "5.135.138.0/24"];
    expect(isEgressRejected("172.24.0.1", extra)).toBe(true);
    expect(isEgressRejected("5.135.138.118", extra)).toBe(true);
    expect(isEgressRejected("1.1.1.1", extra)).toBe(false);
  });

  it("fails closed on unparseable input", () => {
    expect(isEgressRejected("not-an-ip")).toBe(true);
    expect(isEgressRejected("")).toBe(true);
  });
});

describe("decideEgress", () => {
  it("rejects before consulting the allowlist (AC3 ordering)", () => {
    // Even explicitly allowlisted, the reject set wins.
    expect(decideEgress("169.254.169.254", ["169.254.0.0/16"])).toBe("reject");
    expect(decideEgress("192.168.1.1", ["0.0.0.0/0"])).toBe("reject");
    expect(decideEgress("172.24.0.1", ["0.0.0.0/0"], ["172.24.0.1/32"])).toBe("reject");
  });

  it("allows allowlisted public IPs and denies the rest", () => {
    expect(decideEgress("140.82.121.4", ["140.82.121.0/24"])).toBe("allow");
    expect(decideEgress("1.1.1.1", ["140.82.121.0/24"])).toBe("deny");
    expect(decideEgress("1.1.1.1", [])).toBe("deny");
  });
});

describe("hostMatchesAllowlist", () => {
  it("matches exact names and subdomains, nothing else", () => {
    expect(hostMatchesAllowlist("github.com", ["github.com"])).toBe(true);
    expect(hostMatchesAllowlist("api.github.com", ["github.com"])).toBe(true);
    expect(hostMatchesAllowlist("github.com.evil.com", ["github.com"])).toBe(false);
    expect(hostMatchesAllowlist("notgithub.com", ["github.com"])).toBe(false);
    expect(hostMatchesAllowlist("", ["github.com"])).toBe(false);
    expect(hostMatchesAllowlist("GitHub.COM.", ["github.com"])).toBe(true);
  });
});
