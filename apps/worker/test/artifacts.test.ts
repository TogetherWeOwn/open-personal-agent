// SPDX-License-Identifier: Apache-2.0
// Outputs (M3-11): every file a tool writes through its file ports is listed, globally and per
// conversation, with its source run; it previews sandboxed with no `allow-same-origin`, downloads,
// and deletes — and another user's artifact ID is a 404 on every route (the M3-21a isolation
// cases for these routes, landed here until that harness exists on `main`).
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { beforeEach, describe, expect, it } from "vitest";
import { workerApp } from "../src/worker-app";
import { claim, db, env, freshDatabase, ORIGIN, sessionHeaders } from "./helpers/app";

freshDatabase();
// The deployment is claimed first: until then every route but setup answers 403.
beforeEach(() => claim());

const repo = createRepository(env);
const as = (userId: string) => repo.forUser(scopeFromSession({ userId }));

async function user(id: string) {
  await db
    .prepare("INSERT INTO users (id, display_name, role) VALUES (?, ?, 'member')")
    .bind(id, id)
    .run();
  return sessionHeaders(id);
}

const get = (headers: Record<string, string>, path: string, method = "GET") =>
  workerApp.request(`${ORIGIN}${path}`, { method, headers }, env);

interface Listed {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  conversationId: string | null;
  conversationTitle: string | null;
  taskId: string | null;
  turnId: string | null;
}

const list = async (headers: Record<string, string>, query = "") =>
  (await (await get(headers, `/api/artifacts${query}`)).json<{ artifacts: Listed[] }>()).artifacts;

describe("Outputs", () => {
  it("lists what a tool wrote, newest first, globally and per conversation, with its source run", async () => {
    const alice = await user("alice");
    const repoAlice = as("alice");
    await repoAlice.createConversation("trip", "Orkney trip");
    await repoAlice.createConversation("work", "Work");
    // What the host hands `create_artifact`: the ports bound to the run that is writing.
    await repoAlice
      .files({ conversationId: "trip", turnId: "turn-1" })
      .putFile("a1", "# Kirkwall\n\nFerry at 06:30.", "text/markdown", "trip-plan.md");
    await repoAlice
      .files({ conversationId: "work", turnId: "turn-2" })
      .putFile("a2", "q,total\nQ3,12", "text/csv", "totals.csv");

    const all = await list(alice);
    expect(all.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(all[1]).toMatchObject({
      name: "trip-plan.md",
      mediaType: "text/markdown",
      sizeBytes: 27,
      conversationId: "trip",
      conversationTitle: "Orkney trip",
      turnId: "turn-1",
      taskId: null,
    });
    expect((await list(alice, "?conversationId=trip")).map((a) => a.id)).toEqual(["a1"]);
    expect(await list(alice, "?conversationId=none")).toEqual([]);
    expect((await get(alice, "/api/artifacts?conversationId=../x")).status).toBe(400);
    expect((await get(alice, "/api/artifacts?before=soon")).status).toBe(400);

    const one = await get(alice, "/api/artifacts/a1");
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ id: "a1", conversationTitle: "Orkney trip" });
  });

  it("keeps the file when its chat is deleted, with the source cleared", async () => {
    const alice = await user("alice");
    await as("alice").createConversation("gone", "Old chat");
    await as("alice").files({ conversationId: "gone" }).putFile("a1", "x", "text/plain", "x.txt");
    await db.prepare("DELETE FROM conversations WHERE id = 'gone'").run();
    expect(await list(alice)).toMatchObject([{ id: "a1", conversationId: null }]);
  });

  it("refuses a source run that isn't the writer's, and stores nothing", async () => {
    await user("alice");
    await user("bob");
    await as("bob").createConversation("bobs", "Bob's");
    await expect(
      as("alice").files({ conversationId: "bobs" }).putFile("r1", "x", "text/plain", "x.txt"),
    ).rejects.toThrow(/conversation/);
    await expect(
      as("alice").files({ taskId: "t-nope" }).putFile("r2", "x", "text/plain", "x.txt"),
    ).rejects.toThrow(/task/);
    expect(await env.FILES.head("u/alice/files/r1")).toBeNull();
    expect(await env.FILES.head("u/alice/files/r2")).toBeNull();
  });

  it("previews HTML sandboxed without allow-same-origin, framable only by the app", async () => {
    const alice = await user("alice");
    await as("alice")
      .files({})
      .putFile("page", "<script>fetch('/api/me')</script><p>Hi</p>", "text/html", "page.html");
    const res = await get(alice, "/api/artifacts/page/content");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/^sandbox;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("downloads any type as an attachment under its name, and never frames a download", async () => {
    const alice = await user("alice");
    await as("alice").files({}).putFile("md", "# Notes", "text/markdown", "My notes.md");
    const res = await get(alice, "/api/artifacts/md/content?download=1");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="My_notes.md"; filename*=UTF-8''My%20notes.md`,
    );
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(await res.text()).toBe("# Notes");
  });

  it("deletes the row and the object", async () => {
    const alice = await user("alice");
    await as("alice").files({}).putFile("a1", "x", "text/plain", "x.txt");
    expect((await get(alice, "/api/artifacts/a1", "DELETE")).status).toBe(204);
    expect(await list(alice)).toEqual([]);
    expect(await env.FILES.head("u/alice/files/a1")).toBeNull();
    expect((await get(alice, "/api/artifacts/a1", "DELETE")).status).toBe(404);
  });

  it("answers 404 for another user's artifact on every route, and changes nothing", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    await as("alice").createConversation("c1", "Alice's");
    await as("alice")
      .files({ conversationId: "c1" })
      .putFile("a1", "secret", "text/plain", "s.txt");

    expect(await list(bob)).toEqual([]);
    expect(await list(bob, "?conversationId=c1")).toEqual([]);
    for (const path of ["/api/artifacts/a1", "/api/artifacts/a1/content"])
      expect((await get(bob, path)).status, path).toBe(404);
    expect((await get(bob, "/api/artifacts/a1", "DELETE")).status).toBe(404);
    expect((await get(bob, "/api/artifacts/..%2F..%2Falice%2Ffiles%2Fa1/content")).status).toBe(
      404,
    );
    // Alice's file is untouched.
    expect((await list(alice)).map((a) => a.id)).toEqual(["a1"]);
    expect(await env.FILES.head("u/alice/files/a1")).not.toBeNull();
  });
});
