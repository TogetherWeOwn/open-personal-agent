// SPDX-License-Identifier: Apache-2.0
// The Node composition root (ADR 0011 #3): the Worker's Hono app over Node adapters for its
// bindings, so a self-hosted deployment runs the same routes, claim and migrations.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "@opa/worker/app";
import { compose, type WorkerEnv } from "@opa/worker/compose";
import { Hono } from "hono";
import { localBlobStore } from "./blobs";
import { openSqlite, sqliteD1 } from "./d1";
import { modelFetch } from "./egress";
import "./workers-globals";
import { migrate } from "./migrate";

/** Paths the app answers before static assets: `assets.run_worker_first` in `wrangler.jsonc`. */
export const APP_ROUTES = "/api /api/* /agents /agents/* /hooks /hooks/* /setup /setup/*".split(
  " ",
);

export interface NodeOptions {
  /** Holds `opa.sqlite` and `files/`. */
  dataDir: string;
  migrationsDir: string;
  /** The built SPA (`apps/web/dist`). */
  assetsDir: string;
  /**
   * Read for the secrets in `.dev.vars.example`, `OPA_ALLOW_PRIVATE_MODEL_HOSTS` and
   * `OPA_CLIENT_IP_HEADER`, usually `process.env`.
   */
  vars: Record<string, string | undefined>;
  /**
   * The address browsers use, e.g. `https://agent.example` behind a TLS-terminating proxy. The
   * origin checks and passkeys compare against the request URL, so it is rewritten to this.
   */
  publicOrigin?: string | undefined;
}

const isAppRoute = (path: string) =>
  APP_ROUTES.some((r) => (r.endsWith("/*") ? path.startsWith(r.slice(0, -1)) : path === r));

export interface NodeApp {
  fetch(request: Request): Promise<Response>;
  db: DatabaseSync;
}

/**
 * Opens the database, applies pending migrations and wires the bindings. Workers AI and
 * Workflows have no Node adapter yet, so they are declared `UNAVAILABLE` for `/api/health`.
 */
export function createNodeApp(options: NodeOptions): NodeApp {
  const { dataDir, migrationsDir, assetsDir, vars, publicOrigin } = options;
  const origin = publicOrigin && new URL(publicOrigin).origin; // throws if invalid
  const allowPrivate = vars.OPA_ALLOW_PRIVATE_MODEL_HOSTS === "1";
  const db = openSqlite(join(dataDir, "opa.sqlite"));
  migrate(db, migrationsDir);
  // Static files, with the SPA's index.html for any other path, as Workers assets do.
  const assets = new Hono()
    .use(serveStatic({ root: assetsDir }))
    .use(serveStatic({ root: assetsDir, path: "index.html" }));
  const raw = {
    DB: sqliteD1(db),
    FILES: localBlobStore(join(dataDir, "files")),
    ASSETS: { fetch: (request: Request) => assets.fetch(request) },
    // The per-user assistant, in process. It has no state until the chat transport lands.
    ASSISTANT: { idFromName: (name: string) => name, get: () => ({ ping: async () => "pong" }) },
    MODEL_FETCH: modelFetch({ allowPrivate }),
    MODEL_PRIVATE_HOSTS: allowPrivate,
    UNAVAILABLE: ["workflow", "ai"],
    OPA_MASTER_KEY: vars.OPA_MASTER_KEY,
    OPA_MASTER_KEY_PREV: vars.OPA_MASTER_KEY_PREV,
    OPA_SESSION_SECRET: vars.OPA_SESSION_SECRET,
    OPA_SETUP_TOKEN: vars.OPA_SETUP_TOKEN,
    OPA_CLIENT_IP_HEADER: vars.OPA_CLIENT_IP_HEADER,
  } as unknown as WorkerEnv;
  // As on Workers: only `compose` sees the master keys, and it hands the app the vault.
  const env = compose(raw);
  return {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!isAppRoute(url.pathname)) return assets.fetch(request);
      // Not from X-Forwarded-* headers: any client could set those.
      const external = origin ? new URL(url.pathname + url.search, origin) : url;
      return app.fetch(new Request(external, request), await env);
    },
    db,
  };
}
