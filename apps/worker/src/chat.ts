// SPDX-License-Identifier: Apache-2.0
// The chat transport (ADR 0002): a WebSocket to the user's assistant, named from the session only
// (no route takes a name; the SDK's `/agents/*` router isn't mounted), and reads of D1's messages.
import { chatStore, isConversationId } from "@opa/db/chat";
import { createRepository } from "@opa/db/repository";
import { Hono } from "hono";
import { SESSION_HEADER } from "./assistant";
import type { AppEnv } from "./env";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/chat", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "upgrade_required" }, 426);
  }
  // A WebSocket upgrade is a GET and skips CORS, so a cross-site page could open one with the
  // user's cookie. The session guard checks Origin on writes only, so check it here.
  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "bad_origin" }, 403);
  }
  const assistant = createRepository(c.env).forUser(c.var.session.scope).assistant();
  const upgrade = new Request(c.req.raw);
  upgrade.headers.set(SESSION_HEADER, c.var.session.id);
  return assistant.fetch(upgrade);
});

chatRoutes.get("/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  const messages = isConversationId(id)
    ? await chatStore(c.env, c.var.session.scope).listMessages(id)
    : null;
  if (!messages) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ messages });
});
