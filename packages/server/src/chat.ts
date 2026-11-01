// SPDX-License-Identifier: Apache-2.0
// Reads of the user's conversations and their messages from D1, on both runtimes. The chat socket
// itself needs the Assistant Durable Object, so only the Worker serves it
// (apps/worker/src/worker-app.ts).
import { createRepository, isId } from "@opa/db/repository";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { choice } from "./model-settings";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/conversations", async (c) => {
  const rows = await createRepository(c.env).forUser(c.var.session.scope).listConversations();
  c.header("Cache-Control", "no-store");
  return c.json({
    conversations: rows.map(({ id, title, updatedAt, modelProvider, model }) => ({
      id,
      title,
      updatedAt,
      // The conversation's own model (M3-06 AC3); null follows the Chat role. The context chip
      // reads it here so a reload still shows the model a chat will actually use.
      model: modelProvider && model ? { provider: modelProvider, model } : null,
    })),
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

/** Pins the conversation to one of the user's models (M3-06 AC3); `null` follows the Chat role. */
chatRoutes.put("/conversations/:id/model", async (c) => {
  const id = c.req.param("id");
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const body = await c.req.json().catch(() => undefined);
  const pick = body === null ? null : await choice(user, body);
  if (body === undefined || (body !== null && !pick))
    return c.json({ error: "invalid_model" }, 400);
  if (!isId(id) || !(await user.chat.setModel(id, pick)))
    return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
