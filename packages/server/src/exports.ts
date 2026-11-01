// SPDX-License-Identifier: Apache-2.0
// Data export downloads (M3-20 AC1, m3-ux §3.11): the session's own rows only, as with every
// other route. POST starts one export — a second while one runs answers 409 with the running
// row, so the Settings screen's "already being made" state has an answer to show — and the
// Workflow instance starts after the row is claimed, so a start that fails still ends the row
// as failed instead of leaving it running. The list is the row history newest first; the
// download serves a ready row's ZIP as an attachment, never past its expiry.
import { createRepository, type ExportRow, isId } from "@opa/db/repository";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { userContent } from "./security";

/** How long an export stays downloadable: stamped at creation, swept after (PR1). */
export const EXPORT_TTL_MS = 3_600_000;

export const exportRoutes = new Hono<AppEnv>();

/** What the list and the create answer carry: the row's facts, never its R2 keys. */
function present(row: ExportRow) {
  return {
    id: row.id,
    status: row.status,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    readyAt: row.readyAt,
    expiresAt: row.expiresAt,
    error: row.error,
  };
}

exportRoutes.post("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const inFlight = await user.exports.running();
  if (inFlight) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "already_running", export: present(inFlight) }, 409);
  }
  // An export only ever runs on Workers, where R2 always offers multipart (PR2): without the
  // binding there is nothing to run it on.
  const workflows = c.env.EXPORT_WORKFLOW;
  if (typeof workflows?.create !== "function")
    return c.json({ error: "workflow_unavailable" }, 503);
  const id = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  const claimed = await user.exports.create({
    id,
    workflowInstanceId: instanceId,
    expiresAt: Date.now() + EXPORT_TTL_MS,
  });
  if (!claimed) return c.json({ error: "conflict" }, 409);
  try {
    // Called on the binding: its methods reject a detached call.
    await workflows.create({ id: instanceId, params: {} });
  } catch {
    // The run never started: end the row as failed rather than leave it running.
    await user.exports.finishFailed(id, "the export could not start").catch(() => {});
    return c.json({ error: "start_failed" }, 503);
  }
  const row = await user.exports.get(id);
  c.header("Cache-Control", "no-store");
  return c.json(row ? present(row) : { id }, 201);
});

exportRoutes.get("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const rows = await user.exports.list();
  c.header("Cache-Control", "no-store");
  return c.json({ exports: rows.map(present) });
});

exportRoutes.get("/:id/download", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const row = isId(c.req.param("id")) ? await user.exports.get(c.req.param("id")) : undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "running") return c.json({ error: "not_ready" }, 409);
  if (row.status === "failed") return c.json({ error: "export_failed" }, 409);
  // The sweep moves the row at expiry, but a ready row the sweep hasn't reached yet — or one a
  // clock skew finished late — must still not serve.
  if (row.status === "expired" || row.expiresAt <= Date.now())
    return c.json({ error: "expired" }, 410);
  const object = await user.exports.getObject(user.exports.key(row.id));
  if (!object?.body) return c.json({ error: "not_found" }, 404);
  return userContent(object.body, "application/zip", `export-${row.id}.zip`);
});
