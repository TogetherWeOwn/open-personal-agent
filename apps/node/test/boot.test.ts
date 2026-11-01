// SPDX-License-Identifier: Apache-2.0
// Boots apps/node as a child process, as `pnpm start:node` does. Needs `pnpm build` first for the
// web app.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoftPasskey } from "@opa/server/test/softauthn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Behind a TLS-terminating proxy, as in production: browsers use this, the test connects directly.
const PUBLIC = "https://agent.example";
const SECRETS = {
  OPA_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  OPA_SESSION_SECRET: "boot-test-session-secret-0123456789",
  OPA_SETUP_TOKEN: "boot-test-setup-token-0123456789",
};

let child: ChildProcess;
let base = "";
const dataDir = mkdtempSync(join(tmpdir(), "opa-boot-"));

beforeAll(async () => {
  child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: "0",
      OPA_DATA_DIR: dataDir,
      OPA_PUBLIC_ORIGIN: PUBLIC,
      OPA_CLIENT_IP_HEADER: "X-Real-IP",
      ...SECRETS,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  base = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      const url = /on (http:\/\/\S+)/.exec(out)?.[1];
      if (url) resolve(url);
    });
    child.on("exit", (code) => reject(new Error(`exited with ${code}: ${out}`)));
  });
}, 60_000);

afterAll(async () => {
  // SIGTERM drains the server, closes the database and lets the process end on its own.
  const exited = new Promise((resolve) => child?.once("exit", resolve));
  child?.kill("SIGTERM");
  expect(await exited).toBe(0);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("apps/node", () => {
  it("answers /api/health from SQLite and local files with the migrated schema", async () => {
    const res = await fetch(`${base}/api/health`);
    // No Workers AI or Workflows on Node yet: reported as unavailable, without degrading.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      schema: { current: true },
      checks: { database: true, storage: true, durableObject: true, workflow: false, ai: false },
      secrets: { OPA_MASTER_KEY: true, OPA_SESSION_SECRET: true, OPA_SETUP_TOKEN: true },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the web app, with index.html for client routes", async () => {
    for (const path of ["/", "/chat/123"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  it("refuses app routes until the deployment is claimed", async () => {
    const res = await fetch(`${base}/api/me`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_claimed" });
  });

  it("claims the deployment with a passkey, then knows the owner", async () => {
    const cookies = new Map<string, string>();
    const req = async (path: string, body?: unknown) => {
      const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      const init = body === undefined ? {} : { method: "POST", body: JSON.stringify(body) };
      const res = await fetch(`${base}${path}`, { ...init, headers: { origin: PUBLIC, cookie } });
      for (const c of res.headers.getSetCookie()) {
        const [name = "", value = ""] = (c.split(";")[0] ?? "").split("=");
        cookies.set(name, value);
      }
      return res;
    };
    const token = SECRETS.OPA_SETUP_TOKEN;
    const optionsRes = await req("/setup/options", { token });
    expect(optionsRes.status).toBe(200);
    const { options } = (await optionsRes.json()) as { options: { challenge: string } };
    const credential = await new SoftPasskey(new URL(PUBLIC).hostname, PUBLIC).create(options);
    expect((await req("/setup", { token, credential })).status).toBe(200);

    expect(await (await req("/api/me")).json()).toMatchObject({ role: "owner" });
    const missing = await req("/api/nope");
    expect([missing.status, await missing.json()]).toEqual([404, { error: "not_found" }]);
    // The token is spent: a second claim is refused.
    expect((await req("/setup/options", { token })).status).not.toBe(200);
  });

  it("limits recovery codes per address from the configured proxy header", async () => {
    const attempt = (ip: string) =>
      fetch(`${base}/api/auth/recover/options`, {
        method: "POST",
        body: JSON.stringify({ code: "not-a-code" }),
        headers: { origin: PUBLIC, "x-real-ip": ip },
      }).then((res) => res.status);
    for (let i = 0; i < 5; i++) expect(await attempt("192.0.2.1")).toBe(403);
    expect(await attempt("192.0.2.1")).toBe(429);
    // Another client behind the same proxy has its own limit.
    expect(await attempt("192.0.2.2")).toBe(403);
  });
});
