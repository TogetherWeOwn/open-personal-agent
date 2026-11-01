// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPrivateAddress, modelFetch } from "../src/egress";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
  ])("blocks %s", (address) => expect(isPrivateAddress(address)).toBe(true));

  it.each(["1.1.1.1", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (address) =>
    expect(isPrivateAddress(address)).toBe(false),
  );
});

describe("modelFetch", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it("refuses a private IP literal and a name that resolves to loopback", async () => {
    const guarded = modelFetch({ allowPrivate: false });
    for (const url of [
      `http://127.0.0.1:${port}/v1/models`,
      "http://169.254.169.254/latest/meta-data/",
      `http://[::1]:${port}/`,
      `http://localhost:${port}/v1/models`,
    ]) {
      const error = await guarded(url).catch((e: unknown) => e);
      expect(error, url).toBeInstanceOf(TypeError);
      expect((error as TypeError).cause, url).toMatchObject({ code: "EBLOCKED" });
    }
  });

  it("reaches a local model server when the operator allows private hosts", async () => {
    const res = await modelFetch({ allowPrivate: true })(`http://localhost:${port}/v1/models`);
    expect(await res.text()).toBe("ok");
  });
});
