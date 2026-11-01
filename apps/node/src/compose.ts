// SPDX-License-Identifier: Apache-2.0
// The Node composition root (ADR 0011 #3): the Worker's Hono app over Node adapters for its
// bindings, so a self-hosted deployment runs the same routes, claim and migrations.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "@opa/worker/app";
import type { Env } from "@opa/worker/env";
import { Hono } from "hono";
import { localBlobStore } from "./blobs";
import { openSqlite, sqliteD1 } from "./d1";
import { migrate } from "./migrate";

/** Paths the app answers before static assets: `assets.run_worker_first` in `wrangler.jsonc`. */
export const APP_ROUTES = "/api /api/* /agents /agents/* /hooks /hooks/* /setup".split(" ");

export interface NodeOptions {
  /** Holds `opa.sqlite` and `files/`. */
  dataDir: string;
  migrationsDir: string;
  /** The built SPA (`apps/web/dist`). */
  assetsDir: string;
  /** Read for the three secrets in `.dev.vars.example`, usually `process.env`. */
  vars: Record<string, string | undefined>;
}

const isAppRoute = (path: string) =>
  APP_ROUTES.some((r) => (r.endsWith("/*") ? path.startsWith(r.slice(0, -1)) : path === r));

export interface NodeApp {
  fetch(request: Request): Promise<Response>;
  db: DatabaseSync;
}

/**
 * Opens the database, applies pending migrations and wires the bindings. Workers AI and
 * Workflows have no Node adapter yet, so `/api/health` reports them as unavailable.
 */
export function createNodeApp({ dataDir, migrationsDir, assetsDir, vars }: NodeOptions): NodeApp {
  const db = openSqlite(join(dataDir, "opa.sqlite"));
  migrate(db, migrationsDir);
  // Static files, with the SPA's index.html for any other path, as Workers assets do.
  const assets = new Hono()
    .use(serveStatic({ root: assetsDir }))
    .use(serveStatic({ root: assetsDir, path: "index.html" }));
  const env = {
    DB: sqliteD1(db),
    FILES: localBlobStore(join(dataDir, "files")),
    ASSETS: { fetch: (request: Request) => assets.fetch(request) },
    // The per-user assistant, in process. It has no state until the chat transport lands.
    ASSISTANT: { idFromName: (name: string) => name, get: () => ({ ping: async () => "pong" }) },
    OPA_MASTER_KEY: vars.OPA_MASTER_KEY,
    OPA_SESSION_SECRET: vars.OPA_SESSION_SECRET,
    OPA_SETUP_TOKEN: vars.OPA_SETUP_TOKEN,
  } as unknown as Env;
  return {
    fetch: async (request) =>
      isAppRoute(new URL(request.url).pathname) ? app.fetch(request, env) : assets.fetch(request),
    db,
  };
}
