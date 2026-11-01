// SPDX-License-Identifier: Apache-2.0
// A local stack for the end-to-end tests: the built app under `wrangler dev --local` on a state
// directory of its own, plus the mock model server. `restart()` stops the dev server and starts it
// again on the same state, which also evicts the Assistant Durable Object from memory.
// Run `pnpm build` first: the dev server serves apps/web/dist.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMain } from "../../scripts/lib/repo.mjs";
import { startMockOpenAI } from "../../scripts/mock-openai.mjs";

const pkg = createRequire(import.meta.url).resolve("wrangler/package.json");
const wrangler = join(dirname(pkg), "bin/wrangler.js");
const secret = () => randomBytes(32).toString("base64");

/** Runs wrangler with no stdin, so nothing waits for a confirmation. */
function run(args, stdio) {
  return spawn(process.execPath, [wrangler, ...args], {
    stdio: ["ignore", stdio, stdio],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    detached: true, // its own process group, so stopping it also stops workerd
  });
}

/** Resolves once `url` answers 200, polling the web root rather than `/api/health`. */
async function ready(server, url, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`wrangler dev exited (${server.exitCode})`);
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
    if (res?.ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} didn't answer within ${ms} ms`);
}

/**
 * Starts the stack on `port`. The secrets are made once and kept across restarts, so the vault
 * still opens the keys saved before one. A start that fails cleans up what it started.
 */
export async function startStack({ port = 8787, stdio = "ignore" } = {}) {
  const state = mkdtempSync(join(tmpdir(), "opa-e2e-"));
  const setupToken = secret();
  const vars = {
    OPA_MASTER_KEY: secret(),
    OPA_SESSION_SECRET: secret(),
    OPA_SETUP_TOKEN: setupToken,
  };
  const args = ["dev", "--local", "--port", String(port), "--persist-to", state];
  for (const [name, value] of Object.entries(vars)) args.push("--var", `${name}:${value}`);

  const url = `http://localhost:${port}`;
  let model = null;
  let server = null;
  const start = async () => {
    server = run(args, stdio);
    await ready(server, url);
  };
  const stop = () =>
    new Promise((resolve) => {
      if (!server || server.exitCode !== null) return resolve();
      server.once("exit", resolve);
      process.kill(-server.pid, "SIGTERM");
    });
  const close = async () => {
    await stop();
    await model?.close();
    rmSync(state, { recursive: true, force: true });
  };

  try {
    const migrate = spawnSync(
      process.execPath,
      [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
      {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    if (migrate.status !== 0) throw new Error("wrangler d1 migrations apply failed");
    model = await startMockOpenAI({ port: 0 });
    await start();
  } catch (e) {
    await close();
    throw e;
  }
  return {
    url,
    setupToken,
    modelUrl: model.url,
    async restart() {
      await stop();
      await start();
    },
    close,
  };
}

// For Playwright's webServer: `node test/e2e/stack.mjs`, stopped with a signal.
if (isMain(import.meta.url)) {
  const stack = await startStack({ port: Number(process.env.PORT ?? 8787), stdio: "inherit" });
  console.log(`Stack ready: ${stack.url}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => stack.close().then(() => process.exit(0)));
  }
}
