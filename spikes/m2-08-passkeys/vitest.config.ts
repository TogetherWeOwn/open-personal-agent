// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const base = { RP_ID: "opa.test", ORIGIN: "https://opa.test", AUTH_SECRET: "spike-secret-0123456789abcdef0123456789" };
const project = async (name: string) => ({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: `./${name}/wrangler.jsonc` },
      miniflare: {
        bindings: { ...base, MIGRATIONS: name === "a" ? await readD1Migrations(`${import.meta.dirname}/a/migrations`) : [] },
      },
    }),
  ],
  test: { name, include: [`test/${name}.test.ts`] },
});

export default defineConfig({ test: { projects: [await project("a"), await project("b")] } });
