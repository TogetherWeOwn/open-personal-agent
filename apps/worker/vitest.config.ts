// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// readD1Migrations resolves relative paths from the cwd, so anchor it to this file. Vite rewrites
// the literal `import.meta.dirname` to this file's directory when it bundles the config.
const migrationsDir = `${import.meta.dirname}/../../migrations`;

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      // Tests never reach Cloudflare: the AI binding is remote-only, so it stays unbound here.
      remoteBindings: false,
      wrangler: { configPath: "../../wrangler.jsonc" },
      // Tests apply these themselves, so they can also check the unmigrated state.
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
  },
});
