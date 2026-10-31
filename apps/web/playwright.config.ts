// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from "@playwright/test";

// Baselines come from the Playwright image pinned in .github/workflows/visual.yml; update them there.
export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  workers: 1,
  forbidOnly: !!process.env.CI,
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4173" },
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.01 } },
  webServer: {
    command: "pnpm build && pnpm exec vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
  },
});
