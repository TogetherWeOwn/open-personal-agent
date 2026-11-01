// SPDX-License-Identifier: Apache-2.0
// Reads of the user's conversations and their messages from D1, on both runtimes. The chat socket
// itself needs the Assistant Durable Object, so only the Worker serves it
// (apps/worker/src/worker-app.ts).
import { createRepository, isId } from "@opa/db/repository";
import { Hono } from "hono";
import type { AppEnv } from "./env";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/conversations", async (c) => {
  const rows = await createRepository(c.env).forUser(c.var.session.scope).listConversations();
  c.header("Cache-Control", "no-store");
  return c.json({
    conversations: rows.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
  });
});

chatRoutes.get("/conversations/:id/messages", async (c) => {
  const id = c.req.param("id");
  const chat = createRepository(c.env).forUser(c.var.session.scope).chat;
  const messages = isId(id) ? await chat.listMessages(id) : null;
  if (!messages) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ messages });
});
