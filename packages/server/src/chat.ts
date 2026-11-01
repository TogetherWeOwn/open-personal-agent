// SPDX-License-Identifier: Apache-2.0
// Reads of the user's conversations and their messages from D1, on both runtimes. The chat socket
// itself needs the Assistant Durable Object, so only the Worker serves it
// (apps/worker/src/worker-app.ts).
import { createRepository, isId } from "@opa/db/repository";
import { Hono } from "hono";
import { pickModel } from "./chat-model";
import type { AppEnv } from "./env";
import { choice, namesOf } from "./model-settings";

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
  // The thread, with its model-switch lines, so a reload still shows where the voice changed.
  const messages = isId(id) ? await chat.listThread(id) : null;
  if (!messages) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json({ messages });
});

/**
 * Pins the conversation to one of the user's models (M3-06 AC3); `null` follows the Chat role.
 * The thread records the switch in a `system` line (m3-ux §3.2), which the response carries.
 */
chatRoutes.put("/conversations/:id/model", async (c) => {
  const id = c.req.param("id");
  const { scope } = c.var.session;
  const user = createRepository(c.env).forUser(scope);
  const body = await c.req.json().catch(() => undefined);
  const pick = body === null ? null : await choice(user, body);
  if (body === undefined || (body !== null && !pick))
    return c.json({ error: "invalid_model" }, 400);
  // The model the chat uses from now on: its own, or the Chat role's. With neither there is no
  // model to name, so the switch leaves no line.
  const next = await pickModel(c.env, scope, pick ?? { role: "chat" });
  const names = next && namesOf(next.row, next.model);
  const line = names && {
    id: crypto.randomUUID(),
    content: `Switched to ${names.modelName} via ${names.providerName}`,
  };
  if (!isId(id) || !(await user.chat.setModel(id, pick, line ?? undefined)))
    return c.json({ error: "not_found" }, 404);
  const message = line && {
    id: line.id,
    role: "system",
    status: "complete",
    content: line.content,
  };
  return c.json({ message });
});
