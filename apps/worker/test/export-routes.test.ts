// SPDX-License-Identifier: Apache-2.0
// The export routes (M3-20 AC1, m3-ux §3.11): starting an export claims a row and starts its
// Workflow run, a second start while one runs answers 409 with it, the list shows only the
// session's own rows, and the download serves a ready row's ZIP as an attachment — never
// another user's, never before it is ready, never past its expiry.
import { SESSION_COOKIE } from "@opa/server/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Browser, claim, db, env, freshDatabase, sessionHeaders } from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

/** A browser holding `headers`' session cookie, for the second user. */
function asUser(headers: { cookie: string }, path: string, method = "GET"): Promise<Response> {
  const browser = new Browser();
  const [name = "", value = ""] = (headers.cookie.split(";")[0] ?? "").split("=");
  browser.cookies.set(name, value);
  return browser.req(path, { method, body: method === "GET" ? undefined : {} });
}

/** A row written straight to D1, with no Workflow run behind it: it never leaves `running`. */
async function insertRow(
  userId: string,
  id: string,
  status: "running" | "ready" | "failed" | "expired",
  expiresAt: number,
  error: string | null = null,
) {
  await db
    .prepare(
      "INSERT INTO exports (id, user_id, workflow_instance_id, status, expires_at, error) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id, userId, `inst-${id}`, status, expiresAt, error)
    .run();
}

async function postExport(browser: Browser) {
  return browser.req("/api/exports", { method: "POST", body: {} });
}

/** Polls the list until `id` reads `status`, through the real Workflow run. */
async function waitFor(browser: Browser, id: string, status: string) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const list = await (await browser.req("/api/exports")).json<{
      exports: { id: string; status: string }[];
    }>();
    if (list.exports.find((e) => e.id === id)?.status === status) return list;
    if (Date.now() > deadline) throw new Error(`export ${id} never turned ${status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("POST /api/exports", () => {
  it("claims a running export and starts its run", async () => {
    const { browser } = await claim();
    const res = await postExport(browser);
    expect(res.status).toBe(201);
    const row = await res.json<{
      id: string;
      status: string;
      sizeBytes: null;
      createdAt: number;
      readyAt: null;
      expiresAt: number;
      error: null;
    }>();
    expect(row.status).toBe("running");
    expect(row.sizeBytes).toBeNull();
    expect(row.error).toBeNull();
    // The expiry is stamped at creation, one hour out (to the millisecond the row's own
    // creation stamp lands after the route's).
    const ttl = row.expiresAt - row.createdAt;
    expect(ttl).toBeGreaterThan(3_600_000 - 1_000);
    expect(ttl).toBeLessThanOrEqual(3_600_000);
    // The run the POST started finishes it: the row turns ready on its own.
    await waitFor(browser, row.id, "ready");
  });

  it("answers 409 with the running export while one runs", async () => {
    const { browser, owner } = await claim();
    await insertRow(owner, "r1", "running", Date.now() + 3_600_000);
    const res = await postExport(browser);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "already_running",
      export: expect.objectContaining({ id: "r1", status: "running" }),
    });
    // And a finished history never blocks a new one.
    await db.prepare("UPDATE exports SET status = 'failed', error = 'x' WHERE id = 'r1'").run();
    expect((await postExport(browser)).status).toBe(201);
  });

  it("answers 503 where no Workflow binding runs it", async () => {
    const { browser } = await claim();
    const noWorkflow = new Browser({ ...env, EXPORT_WORKFLOW: undefined as never });
    noWorkflow.cookies.set(SESSION_COOKIE, browser.cookies.get(SESSION_COOKIE) as string);
    const res = await postExport(noWorkflow);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "workflow_unavailable" });
  });
});

describe("GET /api/exports", () => {
  it("lists the session's own rows newest first, and nobody else's", async () => {
    const { browser, owner } = await claim();
    await insertRow(owner, "old", "ready", Date.now() + 3_600_000);
    await insertRow(owner, "new", "failed", Date.now() + 3_600_000, "boom");
    await db.prepare("UPDATE exports SET created_at = 1000 WHERE id = 'old'").run();
    await db.prepare("UPDATE exports SET created_at = 2000 WHERE id = 'new'").run();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    await insertRow("u2", "theirs", "ready", Date.now() + 3_600_000);

    const res = await browser.req("/api/exports");
    expect(res.status).toBe(200);
    const { exports } = await res.json<{
      exports: { id: string; status: string; error: string | null }[];
    }>();
    expect(exports.map((e) => e.id)).toEqual(["new", "old"]);
    expect(exports.find((e) => e.id === "new")?.error).toBe("boom");

    const other = await sessionHeaders("u2");
    const theirs = await (await asUser(other, "/api/exports")).json<{
      exports: { id: string }[];
    }>();
    expect(theirs.exports.map((e) => e.id)).toEqual(["theirs"]);
  });
});

describe("GET /api/exports/:id/download", () => {
  it("serves the ready ZIP as a download, and nothing else", async () => {
    const { browser } = await claim();
    const created = await (await postExport(browser)).json<{ id: string }>();
    await waitFor(browser, created.id, "ready");

    const res = await browser.req(`/api/exports/${created.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain(`export-${created.id}.zip`);
    expect(res.headers.get("cache-control")).toContain("no-store");
    // A real archive: the end record closes it and the manifest opens the entries.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(new TextDecoder().decode(bytes)).toContain("conversations.json");
  });

  it("refuses what is not a downloadable row", async () => {
    const { browser, owner } = await claim();
    const now = Date.now();
    await insertRow(owner, "run", "running", now + 3_600_000);
    await insertRow(owner, "bad", "failed", now + 3_600_000, "boom");
    await insertRow(owner, "gone", "expired", now - 1_000);
    await insertRow(owner, "stale", "ready", now - 1_000);

    expect((await browser.req("/api/exports/nope/download")).status).toBe(404);
    expect(await (await browser.req("/api/exports/run/download")).json()).toEqual({
      error: "not_ready",
    });
    expect((await browser.req("/api/exports/run/download")).status).toBe(409);
    expect(await (await browser.req("/api/exports/bad/download")).json()).toEqual({
      error: "export_failed",
    });
    // Expired rows are gone, even a ready one the sweep hasn't moved yet.
    expect((await browser.req("/api/exports/gone/download")).status).toBe(410);
    expect((await browser.req("/api/exports/stale/download")).status).toBe(410);
    // A traversal-flavoured id never reaches a key.
    expect((await browser.req(`/api/exports/..%2F..%2F${owner}/download`)).status).toBe(404);
  });

  it("answers 404 for another user's export", async () => {
    const { owner } = await claim();
    await insertRow(owner, "mine", "ready", Date.now() + 3_600_000);
    await env.FILES.put(`u/${owner}/exports/mine.zip`, "zip");
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    const other = await sessionHeaders("u2");
    expect((await asUser(other, "/api/exports/mine/download")).status).toBe(404);
    expect((await asUser(other, "/api/exports")).status).toBe(200);
  });
});
