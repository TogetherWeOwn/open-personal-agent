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
          include: ["{packages/*,apps/web,scripts}/test/**/*.test.{ts,mjs}"],
        },
      },
      "apps/worker",
    ],
  },
});
