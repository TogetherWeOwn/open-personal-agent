// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "drizzle-kit";

// Writes plain SQL into the root `migrations/`, which wrangler applies (ADR 0004).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "../../migrations",
});
