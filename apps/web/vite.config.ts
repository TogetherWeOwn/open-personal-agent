// SPDX-License-Identifier: Apache-2.0
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const WORKER = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  // `pnpm --filter @opa/web dev` proxies the API, the chat socket and the Finish setup page to a
  // running `wrangler dev`.
  server: { proxy: { "/api": { target: WORKER, ws: true }, "/setup": WORKER } },
});
