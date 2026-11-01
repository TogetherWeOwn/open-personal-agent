// SPDX-License-Identifier: Apache-2.0
// Boots apps/node as a child process, as `pnpm start:node` does. Needs `pnpm build` first for the
// web app.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SECRETS = {
  OPA_MASTER_KEY: "boot-test-master-key-0123456789",
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

afterAll(() => {
  child?.kill("SIGTERM");
  rmSync(dataDir, { recursive: true, force: true });
});

describe("apps/node", () => {
  it("answers /api/health from SQLite and local files with the migrated schema", async () => {
    const res = await fetch(`${base}/api/health`);
    // No Workers AI or Workflows on Node yet, so the deployment reports degraded.
    expect(await res.json()).toMatchObject({
      status: "degraded",
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

  it("answers unknown API routes with the app's JSON 404", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
