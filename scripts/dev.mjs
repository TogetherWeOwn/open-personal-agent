// SPDX-License-Identifier: Apache-2.0
// `pnpm dev`: the mock model server plus the app under `wrangler dev --local`, stopped together.
import { spawn } from "node:child_process";
import { startMockOpenAI } from "./mock-openai.mjs";

const mock = await startMockOpenAI();
console.log(`Mock model server: ${mock.url} (choose "OpenAI-compatible", any API key)`);

const app = spawn("wrangler", ["dev", "--local"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => app.kill(signal));
app.on("exit", async (code) => {
  await mock.close();
  process.exit(code ?? 0);
});
