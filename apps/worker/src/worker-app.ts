// SPDX-License-Identifier: Apache-2.0
// The Worker's app: the shared app plus the chat socket to the user's assistant (ADR 0002), named
// from the session only; the SDK's `/agents/*` router isn't mounted. apps/node never loads it.
import { createRepository } from "@opa/db/repository";
import { createApp } from "@opa/server/app";
import { sameOrigin } from "@opa/server/security";
import { Hono } from "hono";
import { SESSION_HEADER } from "./assistant";
import type { AppEnv } from "./env";

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
