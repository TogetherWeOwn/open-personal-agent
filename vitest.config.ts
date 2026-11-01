// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // Istanbul, because V8 coverage is not available inside workerd.
    coverage: { provider: "istanbul", include: ["**/src/**"], reporter: ["text"] },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["{packages/*,apps/web,scripts}/test/**/*.test.{ts,mjs}"],
        },
      },
      "apps/worker",
      {
        // Black-box tests of the built Worker: run `pnpm deploy:dry-run` first.
        test: { name: "harness", include: ["test/harness/**/*.test.ts"], hookTimeout: 60_000 },
      },
    ],
  },
});
