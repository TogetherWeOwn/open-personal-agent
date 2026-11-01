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

const METADATA = "http://169.254.169.254/latest/meta-data/";

describe("modelFetch", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") return res.writeHead(302, { location: METADATA }).end();
      req.pipe(res);
    });
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

  it("checks every connection, so a redirect to a private literal is refused", async () => {
    // Block only link-local here, so the loopback test server stands in for a public host.
    const linkLocal = (address: string) => address.startsWith("169.254.");
    const guarded = modelFetch({ allowPrivate: false, isBlocked: linkLocal });
    const error = await guarded(`http://127.0.0.1:${port}/redirect`).catch((e: unknown) => e);
    expect((error as TypeError).cause).toMatchObject({ code: "EBLOCKED" });
  });

  it("takes a native Request, as fetch does", async () => {
    const guarded = modelFetch({ allowPrivate: false, isBlocked: () => false });
    const request = new Request(`http://127.0.0.1:${port}/echo`, { method: "POST", body: "hi" });
    expect(await (await guarded(request)).text()).toBe("hi");
  });

  it("reaches a local model server when the operator allows private hosts", async () => {
    const res = await modelFetch({ allowPrivate: true })(`http://localhost:${port}/v1/models`);
    expect(res.status).toBe(200);
  });
});
