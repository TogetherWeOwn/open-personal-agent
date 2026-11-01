// SPDX-License-Identifier: Apache-2.0
// `pnpm dev`: applies the migrations to the local database, then runs the mock model server plus
// the app under `wrangler dev --local`, stopped together.
import { spawn, spawnSync } from "node:child_process";
import { startMockOpenAI } from "./mock-openai.mjs";

// Idempotent. No stdin, so wrangler applies without asking for confirmation.
const migrate = spawnSync("wrangler", ["d1", "migrations", "apply", "DB", "--local"], {
  stdio: ["ignore", "inherit", "inherit"],
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const mock = await startMockOpenAI();
console.log(`Mock model server: ${mock.url} (choose "OpenAI-compatible", any API key)`);

const app = spawn("wrangler", ["dev", "--local"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));
app.on("exit", async (code) => {
  await mock.close();
  process.exit(code ?? 0);
});
