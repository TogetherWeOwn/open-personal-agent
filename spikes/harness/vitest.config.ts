// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { name: "spike-harness", include: ["test/**/*.test.ts"] },
});
