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
