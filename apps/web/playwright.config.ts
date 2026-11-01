// SPDX-License-Identifier: Apache-2.0
import { defineConfig, devices } from "@playwright/test";

// Baselines come from the Playwright image pinned in .github/workflows/visual.yml; update them there.
export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  workers: 1,
  forbidOnly: true,
  // The offline shell's worker would answer before `page.route`; pwa.spec.ts turns it back on.
  use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:4173", serviceWorkers: "block" },
  expect: { toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0.01 } },
  webServer: {
    command: "VITE_MOCK_CHAT=1 pnpm build && pnpm exec vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
  },
});
