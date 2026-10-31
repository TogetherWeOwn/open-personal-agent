// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: [
            "packages/*/test/**/*.test.ts",
            "apps/web/test/**/*.test.ts",
            "scripts/test/**/*.test.ts",
          ],
        },
      },
      "apps/worker",
    ],
  },
});
