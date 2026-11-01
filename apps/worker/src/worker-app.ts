// SPDX-License-Identifier: Apache-2.0
// The Worker's app: the shared app plus the chat socket (ADR 0002), a WebSocket to the user's
// assistant. The DO is named from the session only: no route takes a name, and the SDK's
// `/agents/*` router isn't mounted. apps/node never loads this module (ADR 0011 #3).
import { createRepository } from "@opa/db/repository";
import { Hono } from "hono";
import { createApp } from "./app";
import { SESSION_HEADER } from "./assistant";
import type { AppEnv } from "./env";
import { sameOrigin } from "./security";

const workerRoutes = new Hono<AppEnv>();

workerRoutes.get("/chat", async (c) => {
  // A WebSocket upgrade is a GET and skips CORS, so a cross-site page could open one with the
  // user's cookie. The session guard checks Origin on writes only, so check it here.
  if (!sameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
  const assistant = createRepository(c.env).forUser(c.var.session.scope).assistant();
  const upgrade = new Request(c.req.raw);
  upgrade.headers.set(SESSION_HEADER, c.var.session.id);
  return assistant.fetch(upgrade);
});

export const workerApp = createApp(workerRoutes);
