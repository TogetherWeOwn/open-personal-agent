// SPDX-License-Identifier: Apache-2.0
// The chat transport (ADR 0002): a WebSocket to the user's own assistant, plus reads of the
// conversations D1 keeps. The assistant is named from the session only. No route takes a name,
// and the SDK's `/agents/:class/:name` router is not mounted.
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { assistantName, SESSION_HEADER } from "./assistant";
import { chatStore, isConversationId } from "./chat-store";
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
  const assistant = await getAgentByName(c.env.ASSISTANT, assistantName(c.var.session.userId));
  const upgrade = new Request(c.req.raw);
  upgrade.headers.set(SESSION_HEADER, c.var.session.id);
  return assistant.fetch(upgrade);
});

chatRoutes.get("/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  const messages = isConversationId(id)
    ? await chatStore(c.env.DB, c.var.session.userId).listMessages(id)
    : null;
  if (!messages) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ messages });
});
