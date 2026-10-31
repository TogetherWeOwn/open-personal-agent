// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      // Tests never reach Cloudflare: the AI binding is remote-only, so it stays unbound here.
      remoteBindings: false,
      wrangler: { configPath: "../../wrangler.jsonc" },
    }),
  ],
  test: {
    name: "worker",
    include: ["test/**/*.test.ts"],
  },
});
