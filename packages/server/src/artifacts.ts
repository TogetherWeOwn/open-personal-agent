// SPDX-License-Identifier: Apache-2.0
// Outputs (M3-11, F-3.13): the files tools wrote, listed globally or for one conversation, each
// with its source run. The bytes are served to their owner only, sandboxed with no
// `allow-same-origin` (ADR 0010 D5) — inline where the type previews, else as a download.
import { createRepository, isId } from "@opa/db/repository";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { userContent } from "./security";

export const artifactRoutes = new Hono<AppEnv>();

/**
 * Newest first, a page at a time: `?conversationId=` narrows to one chat; `?before=` and
 * `?beforeId=` (the last row's `createdAt` and `id`) page on.
 */
artifactRoutes.get("/", async (c) => {
  const { conversationId, before, beforeId } = c.req.query();
  if (conversationId !== undefined && !isId(conversationId))
    return c.json({ error: "bad_request" }, 400);
  const cursor = before === undefined ? undefined : Number(before);
  if (cursor !== undefined && !Number.isSafeInteger(cursor))
    return c.json({ error: "bad_request" }, 400);
  // The cursor is both halves or neither: a time alone would skip the rest of a tie.
  if ((cursor === undefined) !== (beforeId === undefined) || (beforeId && !isId(beforeId)))
    return c.json({ error: "bad_request" }, 400);
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const artifacts = await user.artifacts.list({
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(cursor !== undefined ? { before: cursor } : {}),
    ...(beforeId !== undefined ? { beforeId } : {}),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ artifacts });
});

artifactRoutes.get("/:id", async (c) => {
  const row = await createRepository(c.env)
    .forUser(c.var.session.scope)
    .artifacts.get(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(row);
});

/**
 * The file itself. `?download=1` always saves it; otherwise a previewable type shows inline and
 * may be framed by the app's own Outputs page — still under CSP `sandbox`, so its scripts and
 * links get an opaque origin and can't reach the account.
 */
artifactRoutes.get("/:id/content", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const row = await user.artifacts.get(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const object = await user.artifacts.getObject(row.id);
  if (!object?.body) return c.json({ error: "not_found" }, 404);
  const download = c.req.query("download") === "1";
  return userContent(object.body, row.mediaType, row.name, { download, frame: !download });
});

artifactRoutes.delete("/:id", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const row = await user.artifacts.get(c.req.param("id"));
  if (!row || !(await user.artifacts.remove(row.id))) return c.json({ error: "not_found" }, 404);
  // A deletion in the Activity log (M3-19 AC3): the file's name, never its content.
  await user.audit.add({
    action: "artifact.delete",
    module: "artifacts",
    targetId: row.id,
    detail: { name: row.name },
  });
  return c.body(null, 204);
});
