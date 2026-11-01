// SPDX-License-Identifier: Apache-2.0
// The Memory screen's routes and Settings › Memory (M3-15): notes, edits, deletes, proposals, export.
import { registerMemoryTools } from "@opa/db/memory-tools";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { LoopTool } from "@opa/harness-builtin";
import { ToolRegistry } from "@opa/policy";
import { describe, expect, it } from "vitest";
import { workerApp } from "../src/worker-app";
import {
  Browser,
  claim,
  db,
  env,
  freshDatabase,
  ORIGIN,
  type passkey,
  sessionHeaders,
} from "./helpers/app";

freshDatabase();

type Note = {
  id: string;
  text: string;
  trust: string;
  source: string;
  conversation: unknown;
  expiresAt: number | null;
};
type Proposal = Note & { op: string; targets: Note[] };

const tainted = { via: "assistant", tainted: true, userAsserted: true } as const;
const web = { source: "web", ref: "https://example.com", excerpt: "remember this" } as const;
const memoryOf = (userId: string) =>
  createRepository(env).forUser(scopeFromSession({ userId })).memory;

/** The details of the user's audit rows for one action, oldest first. */
const audited = async (userId: string, action: string) =>
  (
    await db
      .prepare("SELECT detail FROM audit_log WHERE user_id = ? AND action = ? ORDER BY id")
      .bind(userId, action)
      .all<{ detail: string }>()
  ).results.map((r) => JSON.parse(r.detail));
const add = async (br: Browser, text: string) =>
  (await (await br.req("/api/memory", { body: { text } })).json<{ memory: Note }>()).memory;
const list = async (br: Browser, q = "") =>
  (
    await (
      await br.req(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`)
    ).json<{
      memories: Note[];
    }>()
  ).memories;

describe("memory notes", () => {
  it("adds a note at user trust, lists it without the user id and finds it by prefix", async () => {
    const { browser } = await claim();
    const note = await add(browser, "  Sam lives in Leeds  ");
    expect(note).toMatchObject({ text: "Sam lives in Leeds", trust: "user" });
    expect(note.source).toBe("memory_screen");
    const [listed, ...rest] = await list(browser);
    expect(rest).toEqual([]);
    expect(listed).toMatchObject({ id: note.id, conversation: null });
    expect(listed).not.toHaveProperty("userId");
    expect((await list(browser, "Lee")).map((m) => m.id)).toEqual([note.id]);
    expect(await list(browser, "Paris")).toEqual([]);
    for (const text of ["", "   ", "x".repeat(2001), 42]) {
      const res = await browser.req("/api/memory", { body: { text } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_text" });
    }
    const typo = await browser.req("/api/memory", {
      body: { text: "Reply in French", kind: "instructionn" },
    });
    expect(typo.status).toBe(400);
    expect(await typo.json()).toEqual({ error: "invalid_kind" });
    expect((await list(browser)).map((m) => m.id)).toEqual([note.id]);
  });

  it("supersedes a note on edit and keeps the old text as a version", async () => {
    const { browser } = await claim();
    const old = await add(browser, "Sam lives in Leeds");
    const res = await browser.req(`/api/memory/${old.id}`, {
      method: "PUT",
      body: { text: "Sam lives in Paris" },
    });
    expect(res.status).toBe(200);
    const { memory } = await res.json<{ memory: Note }>();
    expect(memory.id).not.toBe(old.id);
    expect(memory).toMatchObject({ text: "Sam lives in Paris", trust: "user" });
    const versions = await (await browser.req(`/api/memory/${memory.id}/versions`)).json<{
      versions: Note[];
    }>();
    expect(versions.versions.map((v) => v.text)).toEqual(["Sam lives in Leeds"]);
    const again = await browser.req(`/api/memory/${old.id}`, {
      method: "PUT",
      body: { text: "Sam lives in Rome" },
    });
    expect(again.status).toBe(404);
  });

  it("deletes one note, then bulk deletes and reports the ones it could not", async () => {
    const { browser, owner } = await claim();
    const one = await add(browser, "Likes tea");
    expect((await browser.req(`/api/memory/${one.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await list(browser)).toEqual([]);
    expect((await browser.req(`/api/memory/${one.id}`, { method: "DELETE" })).status).toBe(404);

    const a = await add(browser, "Likes coffee");
    const b = await add(browser, "Likes cake");
    const missing = crypto.randomUUID();
    const res = await browser.req("/api/memory/delete", { body: { ids: [a.id, b.id, missing] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: [a.id, b.id], failed: [missing] });
    expect(await list(browser)).toEqual([]);
    expect((await browser.req("/api/memory/delete", { body: { ids: [] } })).status).toBe(400);
    // Each deletion is in the Activity log by count, never by text (M3-19 AC3).
    expect(await audited(owner, "memory.forget")).toEqual([{ notes: 1 }, { notes: 2 }]);
  });
});

describe("memory proposals", () => {
  it("lists a conflict with its target, expires old ones and accepts, rejects or keeps both", async () => {
    const { browser, owner } = await claim();
    const memory = memoryOf(owner);
    const fact = await add(browser, "Sam lives in Leeds");
    const conflict = await memory.update(tainted, fact.id, "Sam lives in Paris", web);
    expect(conflict.status).toBe("proposed");
    const stale = await memory.create(tainted, "Likes jazz", "fact", web);
    const staleId = stale.status === "proposed" ? stale.proposal.memoryId : "";
    await db.prepare("UPDATE memories SET expires_at = 1 WHERE id = ?").bind(staleId).run();

    const res = await browser.req("/api/memory/proposals");
    const body = await res.json<{ expired: number; proposals: Proposal[] }>();
    expect(body.expired).toBe(1);
    expect(body.proposals).toHaveLength(1);
    const [proposal] = body.proposals;
    expect(proposal).toMatchObject({ text: "Sam lives in Paris", op: "update" });
    expect(proposal?.targets.map((t) => t.id)).toEqual([fact.id]);
    expect(proposal?.targets[0]?.text).toBe("Sam lives in Leeds");

    const id = proposal?.id ?? "";
    expect((await browser.req(`/api/memory/proposals/${id}/maybe`, { body: {} })).status).toBe(404);
    expect((await browser.req(`/api/memory/proposals/${id}/accept`, { body: {} })).status).toBe(
      200,
    );
    expect((await list(browser)).map((m) => m.text)).toEqual(["Sam lives in Paris"]);

    const current = (await list(browser))[0]?.id ?? "";
    const rejected = await memory.update(tainted, current, "Sam lives in Rome", web);
    const rejectedId = rejected.status === "proposed" ? rejected.proposal.memoryId : "";
    expect(
      (await browser.req(`/api/memory/proposals/${rejectedId}/reject`, { body: {} })).status,
    ).toBe(204);
    expect((await list(browser)).map((m) => m.text)).toEqual(["Sam lives in Paris"]);

    const both = await memory.update(tainted, current, "Sam lives in Oslo", web);
    const bothId = both.status === "proposed" ? both.proposal.memoryId : "";
    expect(
      (await browser.req(`/api/memory/proposals/${bothId}/keep-both`, { body: {} })).status,
    ).toBe(200);
    expect((await list(browser)).map((m) => m.text).sort()).toEqual([
      "Sam lives in Oslo",
      "Sam lives in Paris",
    ]);
  });
});

type Options = Parameters<ReturnType<typeof passkey>["get"]>[0];

async function stepUp(br: Browser, key: ReturnType<typeof passkey>) {
  const res = await br.req("/api/auth/step-up/session/options", { body: {} });
  const { options } = await res.json<{ options: Options }>();
  const done = await br.req("/api/auth/step-up/session", {
    body: { credential: await key.get(options) },
  });
  expect(done.status).toBe(200);
}

describe("memory export", () => {
  it("needs a recent passkey step-up, not just the session", async () => {
    const { browser } = await claim();
    const res = await browser.req("/api/memory/export");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "step_up_required" });
  });

  it("downloads every version with its supersede links and never a proposal", async () => {
    const { browser, owner, key } = await claim();
    await stepUp(browser, key);
    const old = await add(browser, "Sam lives in Leeds");
    const edited = await browser.req(`/api/memory/${old.id}`, {
      method: "PUT",
      body: { text: "Sam lives in Paris" },
    });
    const { memory: current } = await edited.json<{ memory: Note }>();
    const proposed = await memoryOf(owner).create(tainted, "Likes jazz", "fact", web);
    expect(proposed.status).toBe("proposed");

    const res = await browser.req("/api/memory/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename=/);
    const body = await res.json<{
      format: string;
      memories: { id: string; text: string; status: string; supersedes: string[] }[];
    }>();
    expect(body.format).toBe("opa-memory-export/v1");
    expect(body.memories.map((m) => [m.id, m.status, m.supersedes]).sort()).toEqual(
      [
        [current.id, "active", [old.id]],
        [old.id, "superseded", []],
      ].sort(),
    );
    expect(body.memories.some((m) => m.text === "Likes jazz")).toBe(false);
  });
});

describe("memory settings", () => {
  it("learns from chats by default and saves a change", async () => {
    const { browser, owner } = await claim();
    expect(await (await browser.req("/api/settings/memory")).json()).toEqual({
      learnFromChats: true,
    });
    const put = await browser.req("/api/settings/memory", {
      method: "PUT",
      body: { learnFromChats: false },
    });
    expect(await put.json()).toEqual({ learnFromChats: false });
    expect(await (await browser.req("/api/settings/memory")).json()).toEqual({
      learnFromChats: false,
    });
    const bad = await browser.req("/api/settings/memory", {
      method: "PUT",
      body: { learnFromChats: "no" },
    });
    expect(bad.status).toBe(400);
    expect(await audited(owner, "settings.memory")).toEqual([
      { learnFromChats: { from: true, to: false } },
    ]);
  });

  it("takes remember from the turn's tools while Learn from our chats is off", async () => {
    const { browser, owner } = await claim();
    // What a host registers for the user's turn, read afresh as each turn starts.
    const turnTools = async () => {
      const tools = new ToolRegistry<LoopTool>();
      await registerMemoryTools(
        tools,
        createRepository(env).forUser(scopeFromSession({ userId: owner })),
        () => ({ tainted: false, userAsserted: true, source: { source: "chat" } }),
      );
      return tools.manifests().map((m) => m.name);
    };
    const learn = (learnFromChats: boolean) =>
      browser.req("/api/settings/memory", { method: "PUT", body: { learnFromChats } });
    expect(await turnTools()).toEqual(["remember", "recall", "forget"]);
    await learn(false);
    expect(await turnTools()).toEqual(["recall", "forget"]);
    await learn(true);
    expect(await turnTools()).toEqual(["remember", "recall", "forget"]);
  });
});

describe("memory access", () => {
  it("keeps one user's notes from another", async () => {
    const { browser } = await claim();
    const note = await add(browser, "Sam lives in Leeds");
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('other', 'O', 'member')")
      .run();
    const headers = { ...(await sessionHeaders("other")), "content-type": "application/json" };
    const as = (path: string, method = "GET", body?: unknown) =>
      workerApp.request(
        `${ORIGIN}${path}`,
        { method, headers, body: body === undefined ? null : JSON.stringify(body) },
        env,
      );
    expect((await as(`/api/memory/${note.id}`, "PUT", { text: "Mine now" })).status).toBe(404);
    expect((await as(`/api/memory/${note.id}`, "DELETE")).status).toBe(404);
    expect(await (await as("/api/memory")).json()).toEqual({ memories: [] });
    expect((await list(browser)).map((m) => m.id)).toEqual([note.id]);
  });

  it("answers 401 without a session once claimed", async () => {
    await claim();
    for (const path of ["/api/memory", "/api/memory/proposals", "/api/settings/memory"]) {
      const res = await new Browser().req(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
  });
});
