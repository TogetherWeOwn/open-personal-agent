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
      // Wrangler reads `.dev.vars.test` before `.dev.vars` (and then skips `.env`), so the empty
      // committed one keeps a developer's local secrets out of tests that need them unset. There is
      // no `env.test` in wrangler.jsonc on purpose (named environments don't inherit bindings), so
      // the "No environment found" warning is expected and harmless.
      wrangler: { configPath: "../../wrangler.jsonc", environment: "test" },
      // Tests apply these themselves, so they can also check the unmigrated state.
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          // The canary-scan CI job sets a fresh value per run and scans the output for it.
          OPA_CANARY: process.env.OPA_CANARY ?? "opa-canary-local-0000000000000000",
        },
      },
    })),
  ],
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000, // a file's first test also loads the Worker bundle, Agents SDK included
  },
});
