// SPDX-License-Identifier: Apache-2.0
// `pnpm start:node`: serves the app on Node. Configuration comes from the environment; see
// `.dev.vars.example` for the secrets.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createNodeApp } from "./compose";

const root = resolve(import.meta.dirname, "../../..");
const dataDir = resolve(root, process.env.OPA_DATA_DIR ?? ".opa-data");
mkdirSync(dataDir, { recursive: true });

const app = createNodeApp({
  dataDir,
  migrationsDir: resolve(root, "migrations"),
  assetsDir: resolve(root, "apps/web/dist"),
  vars: process.env,
  publicOrigin: process.env.OPA_PUBLIC_ORIGIN,
});

// Loopback by default: put a TLS-terminating proxy in front to expose it.
const hostname = process.env.OPA_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
// The chat socket's upgrades (M3-23a): the route answers through this server, `noServer` so the
// same port serves the app and the assistant, as the Worker's Durable Object does.
// `ws` types `noServer` as optional; it is set, so the cast only narrows that.
const wss = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
const server = serve({ fetch: app.fetch, hostname, port, websocket: { server: wss } }, (info) => {
  console.log(`Open Personal Agent on http://${hostname}:${info.port}`);
});

// The Worker's */10 cron (wrangler.jsonc), once at start too: a pending key rotation and retention.
const TICK_MS = 10 * 60_000;
void app.scheduled();
const tick = setInterval(() => void app.scheduled(), TICK_MS);

// Finish in-flight requests before closing the database; a second signal exits at once.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(tick);
    server.close(() => app.db.close());
  });
}
