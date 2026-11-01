// SPDX-License-Identifier: Apache-2.0
// The Node composition root (ADR 0011 #3): the shared app (`@opa/server`) over Node adapters for
// its ports, so a self-hosted deployment runs the same routes, claim and migrations.
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "@opa/server/app";
import { compose, type MasterKeys } from "@opa/server/compose";
import type { AppPorts } from "@opa/server/env";
import { runRetention } from "@opa/server/retention";
import { runRotation } from "@opa/server/vault-rotation";
import { Hono } from "hono";
import { NodeAssistant, nodeRoutes } from "./assistant";
import { localBlobStore } from "./blobs";
import { openSqlite, sqliteD1 } from "./d1";
import { modelFetch } from "./egress";
import "./workers-globals";
import { migrate } from "./migrate";
import { memoryRateLimit } from "./rate-limit";

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

/** Where the client's address comes from when no proxy names a header: the socket. */
export const SOCKET_ADDRESS_HEADER = "x-opa-socket-address";

/** What `@hono/node-server` passes as `fetch`'s second argument. */
interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string | undefined } };
}

export interface NodeApp {
  fetch(request: Request, bindings?: NodeBindings): Promise<Response>;
  /** The Worker's cron (every 10 minutes): `main.ts` runs it on a timer. */
  scheduled(): Promise<void>;
  db: DatabaseSync;
  /** The user's in-process assistant, one per user, as `/api/chat` and the routes reach it. */
  assistantFor(userId: string): NodeAssistant;
  /**
   * Refuses new turns, closes every chat tab and interrupts running turns, resolving once they
   * have settled. Shutdown awaits it before closing the database, since upgraded sockets are
   * not tracked by `server.close`. Assistants created after shutdown starts are born closing,
   * so their turns can't outlive the database close.
   */
  shutdown(): Promise<void>;
}

/**
 * Opens the database, applies pending migrations and wires the bindings. Workers AI and
 * Workflows have no Node adapter yet, so they are declared `UNAVAILABLE` for `/api/health`.
 */
export function createNodeApp(options: NodeOptions): NodeApp {
  const { dataDir, migrationsDir, assetsDir, vars, publicOrigin } = options;
  const origin = publicOrigin && new URL(publicOrigin).origin; // throws if invalid
  const allowPrivate = vars.OPA_ALLOW_PRIVATE_MODEL_HOSTS === "1";
  const proxyHeader = vars.OPA_CLIENT_IP_HEADER;
  const db = openSqlite(join(dataDir, "opa.sqlite"));
  migrate(db, migrationsDir);
  // Static files, with the SPA's index.html for any other path, as Workers assets do.
  const assets = new Hono()
    .use(serveStatic({ root: assetsDir }))
    .use(serveStatic({ root: assetsDir, path: "index.html" }));
  // The user's in-process assistant, one per user like the Worker's Durable Object. The
  // database outlives them; a restart drops only the sockets, which reconnect and resume.
  const assistants = new Map<string, NodeAssistant>();
  // Set before the shutdown snapshot: an assistant created while the drain runs starts already
  // closing, so no new turn can outlive the database close.
  let closing = false;
  const { assistantFor } = {
    assistantFor(userId: string): NodeAssistant {
      let assistant = assistants.get(userId);
      if (!assistant) {
        assistant = new NodeAssistant(userId, { db, getEnv: () => env });
        assistants.set(userId, assistant);
        if (closing) {
          // Born mid-drain, after the shutdown snapshot: refuse new turns at once. It holds no
          // tabs and no running turn, so there is nothing to await.
          void assistant.shutdown().catch(() => {});
        } else {
          // Settle what a restart left behind (streaming replies, dead budget holds) before the
          // first turn needs to; the sweep runs once per process and never raises unhandled.
          void assistant.recover().catch(() => {});
        }
      }
      return assistant;
    },
  };
  const raw: AppPorts & MasterKeys = {
    DB: sqliteD1(db),
    FILES: localBlobStore(join(dataDir, "files")),
    ASSETS: { fetch: (request: Request) => assets.fetch(request) },
    ASSISTANT: {
      idFromName: (name: string) => name,
      get: (name: string) =>
        name.startsWith("u:") ? assistantFor(name.slice(2)) : { ping: async () => "pong" },
    },
    MODEL_FETCH: modelFetch({ allowPrivate }),
    MODEL_PRIVATE_HOSTS: allowPrivate,
    UNAVAILABLE: ["workflow", "ai"],
    OPA_MASTER_KEY: vars.OPA_MASTER_KEY,
    OPA_MASTER_KEY_PREV: vars.OPA_MASTER_KEY_PREV,
    OPA_SESSION_SECRET: vars.OPA_SESSION_SECRET,
    OPA_SETUP_TOKEN: vars.OPA_SETUP_TOKEN,
    OPA_ATTACHMENT_MAX_BYTES: vars.OPA_ATTACHMENT_MAX_BYTES,
    // No proxy header named: key per-address limits on the socket, never on a header the client
    // sends, such as CF-Connecting-IP, which only Cloudflare sets.
    OPA_CLIENT_IP_HEADER: proxyHeader || SOCKET_ADDRESS_HEADER,
    PUBLIC_LIMIT: memoryRateLimit(30, 60_000), // the Worker's `ratelimits` in wrangler.jsonc
  };
  // As on Workers: only `compose` sees the master keys, and it hands the app the vault.
  const env = compose(raw);
  const nodeApp = createApp(nodeRoutes(assistantFor));
  return {
    fetch: async (request, bindings) => {
      const url = new URL(request.url);
      if (!isAppRoute(url.pathname)) return assets.fetch(request);
      // Not from X-Forwarded-* headers: any client could set those.
      const external = origin ? new URL(url.pathname + url.search, origin) : url;
      const forwarded = new Request(external, request);
      if (!proxyHeader) {
        // Always overwritten, so a client can't pick its own address.
        forwarded.headers.delete(SOCKET_ADDRESS_HEADER);
        const address = bindings?.incoming?.socket?.remoteAddress;
        if (address) forwarded.headers.set(SOCKET_ADDRESS_HEADER, address);
      }
      // Over the bindings `@hono/node-server` passes in: on an upgrade they carry its symbols,
      // which `upgradeWebSocket` reads from the env. A new object would drop them, and with them
      // the tab's socket (the symbols link the route's reply to the upgrade).
      return nodeApp.fetch(forwarded, Object.assign(bindings ?? {}, await env));
    },
    scheduled: async () => {
      const app = await env;
      await runRotation(app);
      await runRetention(app);
    },
    db,
    assistantFor,
    shutdown: async () => {
      // Gate first: the listener still accepts upgrades during the drain, and any assistant
      // created after this point starts already closing (see `assistantFor`).
      closing = true;
      await Promise.all([...assistants.values()].map((assistant) => assistant.shutdown()));
    },
  };
}
