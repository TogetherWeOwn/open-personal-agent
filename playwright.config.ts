// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from "@playwright/test";

// Two suites on the real app (apps/web/playwright.config.ts is the UI suite on mocked routes):
// - `e2e` (test/e2e) starts its own stacks, because it restarts them;
// - `acceptance` checks any deployment at BASE_URL, or a local stack started here without one.
// Run `pnpm build` first.
const baseURL = process.env.BASE_URL ?? "http://localhost:8790";

export default defineConfig({
  workers: 1,
  forbidOnly: true,
  timeout: 120_000,
  use: { ...devices["Desktop Chrome"] },
  projects: [
    { name: "e2e", testDir: "test/e2e" },
    { name: "acceptance", testDir: "acceptance", use: { baseURL } },
  ],
  webServer: process.env.BASE_URL
    ? []
    : {
        command: "node test/e2e/stack.mjs",
        env: { PORT: "8790" },
        url: baseURL,
        timeout: 120_000,
        // The stack stops its dev server's process group on SIGTERM; SIGKILL would orphan it.
        gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      },
});
