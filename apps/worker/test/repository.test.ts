// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import {
  createRepository,
  scopeForAssistant,
  scopeFromSession,
  type UserScope,
} from "@opa/db/repository";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/compose";

const env = workerEnv as unknown as WorkerEnv & { TEST_MIGRATIONS: D1Migration[] };
const repo = createRepository(env);
const [alice, bob] = ["alice", "bob"].map((userId) => repo.forUser(scopeFromSession({ userId })));

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member')",
  ).run();
});

describe("scoped repository", () => {
  it("never returns another user's row", async () => {
    await alice?.createConversation("c1", "Alice's");
    expect((await alice?.getConversation("c1"))?.title).toBe("Alice's");
    expect(await bob?.getConversation("c1")).toBeUndefined();
    expect(await bob?.listConversations()).toEqual([]);
  });

  it("refuses a scope the session layer didn't issue", () => {
    expect(() => repo.forUser({ userId: "alice" } as UserScope)).toThrow(/not issued/);
    expect(() => scopeFromSession({ userId: "" })).toThrow();
    for (const name of ["u:", "health", "x:alice", "u:a b"])
      expect(() => scopeForAssistant(name), name).toThrow();
    expect(scopeForAssistant("u:alice").userId).toBe("alice");
  });

  it("searches only the caller's history, with the query matched literally (M3-08 AC2)", async () => {
    await alice?.createConversation("cs", "Trips");
    await bob?.createConversation("cs2", "Bob's trips");
    const insert = (id: string, userId: string, conversationId: string, content: string) =>
      env.DB.prepare(
        "INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content) VALUES (?, ?, ?, 1, 'user', 'complete', ?)",
      )
        .bind(id, userId, conversationId, content)
        .run();
    await insert("m1", "alice", "cs", "Book the ferry to Kirkwall, 100% sure this time");
    await insert("m2", "bob", "cs2", "Book the ferry to Kirkwall too");

    const aliceHits = (await alice?.chat.searchHistory("kirkwall", 10)) ?? [];
    expect(aliceHits.map((h) => h.messageId)).toEqual(["m1"]);
    expect(aliceHits[0]).toMatchObject({ conversationId: "cs", conversationTitle: "Trips" });
    expect(aliceHits[0]?.snippet).toContain("Kirkwall");
    // Bob finds his own message and never Alice's, even asking for her exact words.
    expect((await bob?.chat.searchHistory("Kirkwall", 10))?.map((h) => h.messageId)).toEqual([
      "m2",
    ]);
    expect(await bob?.chat.searchHistory("100% sure", 10)).toEqual([]);
    // LIKE wildcards in the query are literal text, not a match-everything pattern.
    expect(await bob?.chat.searchHistory("%", 10)).toEqual([]);
    expect((await alice?.chat.searchHistory("100% sure", 10))?.map((h) => h.messageId)).toEqual([
      "m1",
    ]);
    // SQLite LIKE folds A–Z only: other scripts match exactly as typed (documented contract).
    await insert("m3", "alice", "cs", "CAFÉ on the corner");
    expect((await alice?.chat.searchHistory("CAFÉ", 10))?.map((h) => h.messageId)).toEqual(["m3"]);
    expect(await alice?.chat.searchHistory("café", 10)).toEqual([]);
  });

  it("keeps files under the user's prefix and names the assistant from the scope", async () => {
    await alice?.putFile("f1", "hello", "text/plain");
    expect(await env.FILES.head("u/alice/files/f1")).not.toBeNull();
    expect(await bob?.getFile("f1")).toBeNull();
    expect(() => bob?.getFile("../../alice/files/f1")).toThrow(/invalid id/);
    const id = env.ASSISTANT.idFromName("u:alice").toString();
    expect(alice?.assistant().id.toString()).toBe(id);
    expect(bob?.assistant().id.toString()).not.toBe(id);
  });

  it("keeps stopped turn state scoped to its user (AC5)", async () => {
    await alice?.createConversation("turns-c1", "Turns");
    const saved = {
      turnId: "turn-1",
      conversationId: "turns-c1",
      replyId: "reply-1",
      providerId: "test",
      model: "test-model",
      status: "awaiting_approval" as const,
      state: '{"counts":{"calls":1,"tools":0}}',
    };
    expect(await alice?.turns.save(saved)).toBe(true);
    expect(await alice?.turns.load("turn-1")).toEqual(saved);
    // Another user cannot see, refresh or delete it.
    expect(await bob?.turns.load("turn-1")).toBeUndefined();
    expect(await bob?.turns.save({ ...saved, turnId: "turn-bob" })).toBe(false);
    await bob?.turns.remove("turn-1");
    expect(await alice?.turns.load("turn-1")).toEqual(saved);
    // A second stop replaces the first in place.
    expect(await alice?.turns.save({ ...saved, status: "limit_reached", state: "{}" })).toBe(true);
    expect((await alice?.turns.load("turn-1"))?.status).toBe("limit_reached");
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM turn_states WHERE turn_id = 'turn-1'",
    ).first("n");
    expect(rows).toBe(1);
    await alice?.turns.remove("turn-1");
    expect(await alice?.turns.load("turn-1")).toBeUndefined();
    // Deleting the conversation takes its saved turns with it (cascade).
    expect(await alice?.turns.save(saved)).toBe(true);
    await env.DB.prepare("DELETE FROM conversations WHERE id = 'turns-c1'").run();
    expect(await alice?.turns.load("turn-1")).toBeUndefined();
  });
});

describe("attachment upload with no declared length", () => {
  it("cuts R2 multipart parts at exactly 5 MiB, carrying a split chunk into the next", async () => {
    const sizes: number[] = [];
    const FILES = {
      ...env.FILES,
      createMultipartUpload: async () => ({
        uploadPart: async (partNumber: number, value: Uint8Array) => {
          sizes.push(value.byteLength);
          return { partNumber, etag: `e${partNumber}` };
        },
        complete: async () => ({}),
        abort: async () => ({}),
      }),
    };
    const files = createRepository({ ...env, FILES } as never).forUser(
      scopeFromSession({ userId: "alice" }),
    ).attachments;
    const chunk = new Uint8Array(3_000_000);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 7; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    await files.putObject("multi", body, "text/plain");
    const part = 5 * 1024 * 1024;
    // R2 refuses a multipart upload whose non-last parts differ in size.
    expect(sizes).toEqual([part, part, part, part, 7 * 3_000_000 - 4 * part]);
  });
});
