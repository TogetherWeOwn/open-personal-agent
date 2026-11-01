// SPDX-License-Identifier: Apache-2.0
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPrivateAddress, modelFetch, pageFetch } from "../src/egress";

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

const PUBLIC = "http://1.1.1.1/v1/models";

describe("modelFetch", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/to-public") return res.writeHead(302, { location: PUBLIC }).end();
      if (req.url === "/moved") return res.writeHead(307, { location: "/echo" }).end();
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

  it("checks every connection, so a redirect to a refused literal is refused", async () => {
    // The loopback server is allowed; the hop to plain HTTP on a public address is not.
    const guarded = modelFetch({ allowPrivate: true });
    const error = await guarded(`http://127.0.0.1:${port}/to-public`).catch((e: unknown) => e);
    expect((error as TypeError).cause).toMatchObject({ code: "EBLOCKED" });
  });

  it("refuses plain HTTP to a public address, even with private hosts allowed", async () => {
    const guarded = modelFetch({ allowPrivate: true, isBlocked: () => false });
    for (const url of [`http://127.0.0.1:${port}/v1/models`, `http://localhost:${port}/v1`]) {
      const error = await guarded(url).catch((e: unknown) => e);
      expect((error as TypeError).cause, url).toMatchObject({
        code: "EBLOCKED",
        message: expect.stringContaining("needs https"),
      });
    }
  });

  it("resends the body on a 307 redirect, as fetch does", async () => {
    const guarded = modelFetch({ allowPrivate: true });
    const res = await guarded(`http://127.0.0.1:${port}/moved`, { method: "POST", body: "hi" });
    expect(await res.text()).toBe("hi");
  });

  it("takes a native Request, as fetch does", async () => {
    const guarded = modelFetch({ allowPrivate: true });
    const request = new Request(`http://127.0.0.1:${port}/echo`, { method: "POST", body: "hi" });
    expect(await (await guarded(request)).text()).toBe("hi");
  });

  it("reaches a local model server when the operator allows private hosts", async () => {
    const res = await modelFetch({ allowPrivate: true })(`http://localhost:${port}/v1/models`);
    expect(res.status).toBe(200);
  });
});

describe("pageFetch (M3-08 AC1: the web_fetch SSRF guard on Node)", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/to-metadata") {
        return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("page");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it("refuses private, loopback, link-local and metadata addresses, with no opt-out", async () => {
    const guarded = pageFetch();
    for (const url of [
      `http://127.0.0.1:${port}/`,
      `http://localhost:${port}/`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      `https://[::1]:${port}/`,
    ]) {
      const error = await guarded(url).catch((e: unknown) => e);
      expect(error, url).toBeInstanceOf(TypeError);
      expect((error as TypeError).cause, url).toMatchObject({ code: "EBLOCKED" });
    }
  });

  it("checks the redirect hop: a public page can't bounce it to the metadata service", async () => {
    // The first hop is loopback in this test, so let only it through the address check; the
    // redirect target is then judged on its own address, as a public page's would be.
    const guarded = pageFetch({
      isBlocked: (address) => address !== "127.0.0.1" && isPrivateAddress(address),
    });
    const error = await guarded(`http://127.0.0.1:${port}/to-metadata`).catch((e: unknown) => e);
    expect((error as TypeError).cause).toMatchObject({ code: "EBLOCKED" });
  });

  it("allows plain HTTP to a public address (the request carries no key)", async () => {
    const guarded = pageFetch({ isBlocked: () => false });
    const res = await guarded(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe("page");
  });
});
