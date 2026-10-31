// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { createRepository, scopeFromSession, type UserScope } from "@opa/db/repository";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/index";

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
});
