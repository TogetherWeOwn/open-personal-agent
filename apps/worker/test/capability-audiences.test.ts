// SPDX-License-Identifier: Apache-2.0

import { runInDurableObject } from "cloudflare:test";
import { mintCapabilityToken } from "@opa/db/capability-tokens";
import { computerStore } from "@opa/db/computers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { SqlDatabase } from "@opa/db/system";
import { expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { EventLog } from "../src/event-log";
import { workerApp } from "../src/worker-app";
import { claim, db, env, freshDatabase, ORIGIN } from "./helpers/app";

freshDatabase();

it("announces the saved Output to connected tabs without borrowing the Workflow sequence", async () => {
  const { browser, upload } = await uploadOwner();
  const cookie = [...browser.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const connection = await workerApp.request(
    `${ORIGIN}/api/chat`,
    {
      headers: { upgrade: "websocket", origin: ORIGIN, cookie },
    },
    env,
  );
  const ws = connection.webSocket;
  expect(ws).toBeTruthy();
  if (!ws) return;
  ws.accept();
  const events: { type: string; payload: unknown }[] = [];
  ws.addEventListener("message", (event) => {
    events.push(JSON.parse(String(event.data)));
  });
  try {
    const response = await upload("hello");
    expect(response.status).toBe(201);
    const artifact = await response.json<{ id: string }>();
    await vi.waitFor(
      () =>
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "artifact.created",
            payload: { artifactId: artifact.id, name: "answer.txt", type: "text/plain", bytes: 5 },
          }),
        ),
      { timeout: 2000 },
    );
  } finally {
    ws.close();
  }
});

it.each([
  { turnId: null, taskId: "upload-task", retained: 0 },
  { turnId: null, taskId: null, retained: 0 },
  { turnId: "live-turn", taskId: "upload-task", retained: 2 },
])(
  "retains only turn-associated notification frames ($turnId, $taskId)",
  async ({ turnId, taskId, retained }) => {
    const { owner, user } = await uploadOwner();
    await user.artifacts.save({
      id: "notified-artifact",
      name: "answer.txt",
      mediaType: "text/plain",
      content: "hello",
      source: { conversationId: "upload-chat", taskId, turnId },
    });
    const frameKey = turnId ?? taskId ?? "notified-artifact";
    const frames = await runInDurableObject(
      env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${owner}`)),
      async (instance: Assistant, state) => {
        const log = new EventLog(state.storage.sql);
        log.append("upload-chat", "unrelated-turn", () => "unrelated");
        await instance.artifactCreated("notified-artifact");
        await instance.artifactCreated("notified-artifact");
        return {
          retained: log.replay("upload-chat", frameKey, 0),
          unrelated: log.replay("upload-chat", "unrelated-turn", 0),
          next: JSON.parse(log.append("upload-chat", "next-turn", (seq) => JSON.stringify({ seq })))
            .seq,
        };
      },
    );
    expect(frames.retained).toHaveLength(retained);
    expect(frames.unrelated).toEqual(["unrelated"]);
    expect(frames.next).toBe(4);
  },
);

it("returns the published artifact when its notification fails", async () => {
  const { token, user, browser } = await uploadOwner();
  const response = await workerApp.request(
    `${ORIGIN}/api/agent/tasks/upload-task/artifacts`,
    {
      method: "POST",
      body: "hello",
      headers: { origin: ORIGIN, authorization: `Bearer ${token}`, "x-file-name": "answer.txt" },
    },
    {
      ...env,
      ASSISTANT: {
        idFromName: (name: string) => env.ASSISTANT.idFromName(name),
        get: () => ({
          artifactCreated: async () => {
            throw new Error("notification unavailable");
          },
        }),
      } as unknown as typeof env.ASSISTANT,
    },
  );
  expect(response.status).toBe(201);
  const artifact = await response.json<{ id: string }>();
  expect(await user.artifacts.list()).toMatchObject([{ id: artifact.id, sizeBytes: 5 }]);
  expect(await (await browser.req(`/api/artifacts/${artifact.id}/content`)).text()).toBe("hello");
  expect(await db.prepare("SELECT count(*) AS n FROM capability_uploads").first("n")).toBe(1);
});

it("reserves object quota atomically before accepting concurrent uploads", async () => {
  const { upload, user } = await uploadOwner();
  const responses = await Promise.all(Array.from({ length: 17 }, () => upload("x")));
  expect(responses.filter((res) => res.status === 201)).toHaveLength(16);
  expect(responses.filter((res) => res.status === 429)).toHaveLength(1);
  expect(await user.artifacts.list()).toHaveLength(16);
});

it("charges cumulative bytes while streaming even without Content-Length", async () => {
  const { upload, user } = await uploadOwner();
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345678"));
        controller.close();
      },
    });
  const responses = await Promise.all(Array.from({ length: 5 }, () => upload(stream(), {}, 8)));
  expect(responses.filter((res) => res.status === 201)).toHaveLength(4);
  expect(responses.filter((res) => res.status === 429)).toHaveLength(1);
  expect(await user.artifacts.list()).toHaveLength(4);
});

it("does not reset task byte quota when the upload token rotates", async () => {
  const { upload, owner, computer } = await uploadOwner();
  let token: string | undefined;
  for (let round = 0; round < 4; round++) {
    if (round > 0)
      token = (
        await mintCapabilityToken(db as unknown as SqlDatabase, {
          userId: owner,
          taskId: "upload-task",
          computerId: computer.id,
          aud: "artifact_upload",
        })
      ).token;
    for (let i = 0; i < 4; i++) {
      expect(
        (await upload("12345678", token ? { authorization: `Bearer ${token}` } : {}, 8)).status,
      ).toBe(201);
    }
  }
  const fresh = await mintCapabilityToken(db as unknown as SqlDatabase, {
    userId: owner,
    taskId: "upload-task",
    computerId: computer.id,
    aud: "artifact_upload",
  });
  expect((await upload("x", { authorization: `Bearer ${fresh.token}` }, 8)).status).toBe(429);
});

it.each([
  {
    name: "per-file streaming overflow",
    tail: new Uint8Array(89).fill(120),
    cap: 600,
    status: 413,
  },
  {
    name: "invalid text after the sniff window",
    tail: new Uint8Array([0]),
    cap: 1024,
    status: 415,
  },
  {
    name: "truncated UTF-8 after the sniff window",
    tail: new Uint8Array([0xc3]),
    cap: 1024,
    status: 415,
  },
])("cleans up stored parts on $name", async ({ tail, cap, status }) => {
  const { upload, user, owner } = await uploadOwner();
  let chunk = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (chunk++ === 0) controller.enqueue(new Uint8Array(512).fill(120));
        else if (chunk === 2) controller.enqueue(tail);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  expect((await upload(stream, {}, cap)).status).toBe(status);
  expect(await user.artifacts.list()).toEqual([]);
  expect((await env.FILES.list({ prefix: `u/${owner}/files/` })).objects).toEqual([]);
});

it("rechecks liveness after the final chunk before publishing metadata", async () => {
  const { upload, user, owner } = await uploadOwner();
  let first = true;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new Uint8Array(512).fill(120));
        } else {
          await db
            .prepare("UPDATE capability_tokens SET revoked_at = ? WHERE task_id = 'upload-task'")
            .bind(Date.now())
            .run();
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  expect((await upload(stream)).status).toBe(401);
  expect(await user.artifacts.list()).toEqual([]);
  expect((await env.FILES.list({ prefix: `u/${owner}/files/` })).objects).toEqual([]);
});

it("keeps failed upload attempts charged against object quota", async () => {
  const { upload, user } = await uploadOwner();
  for (let i = 0; i < 16; i++) expect((await upload(new Uint8Array([0]))).status).toBe(415);
  expect((await upload("hello")).status).toBe(429);
  expect(await user.artifacts.list()).toEqual([]);
});

it("does not reset task object quota across token rotation", async () => {
  const { upload, owner, computer } = await uploadOwner();
  for (let round = 0; round < 4; round++) {
    const token = await mintCapabilityToken(db as unknown as SqlDatabase, {
      userId: owner,
      taskId: "upload-task",
      computerId: computer.id,
      aud: "artifact_upload",
    });
    for (let i = 0; i < 16; i++)
      expect((await upload("x", { authorization: `Bearer ${token.token}` })).status).toBe(201);
  }
  const token = await mintCapabilityToken(db as unknown as SqlDatabase, {
    userId: owner,
    taskId: "upload-task",
    computerId: computer.id,
    aud: "artifact_upload",
  });
  expect((await upload("x", { authorization: `Bearer ${token.token}` })).status).toBe(429);
});

async function uploadOwner() {
  const { browser, owner } = await claim();
  const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
  await user.chat.open("upload-chat", "Upload");
  await user.tasks.create({
    id: "upload-task",
    conversationId: "upload-chat",
    kind: "turn",
    mode: "background",
  });
  const computer = await computerStore(env).create(
    {
      userId: owner,
      taskId: "upload-task",
      provider: "fake",
      profile: "host",
      providerComputerId: "upload",
    },
    Date.now(),
  );
  const minted = await mintCapabilityToken(db as unknown as SqlDatabase, {
    userId: owner,
    taskId: "upload-task",
    computerId: computer.id,
    aud: "artifact_upload",
  });
  const upload = (body: BodyInit, headers: Record<string, string> = {}, maxBytes?: number) =>
    workerApp.request(
      `${ORIGIN}/api/agent/tasks/upload-task/artifacts`,
      {
        method: "POST",
        body,
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${minted.token}`,
          "x-file-name": "../answer.txt",
          ...headers,
        },
      },
      maxBytes === undefined ? env : { ...env, OPA_ATTACHMENT_MAX_BYTES: String(maxBytes) },
    );
  return { browser, owner, user, computer, upload, token: minted.token };
}

it("publishes a sniffed computer upload in Outputs without granting reads or deletes", async () => {
  const { browser, upload, token } = await uploadOwner();
  const res = await upload("hello", { "content-type": "text/html" });
  expect(res.status).toBe(201);
  const artifact = await res.json<{
    id: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
  }>();
  expect(artifact).toMatchObject({ name: "answer.txt", mediaType: "text/plain", sizeBytes: 5 });
  const outputs = await browser.req("/api/artifacts");
  expect(await outputs.json()).toMatchObject({
    artifacts: [expect.objectContaining({ id: artifact.id, taskId: "upload-task" })],
  });
  const content = await browser.req(`/api/artifacts/${artifact.id}/content`);
  expect(await content.text()).toBe("hello");
  expect(content.headers.get("content-security-policy")).toContain("sandbox");
  for (const [method, path] of [
    ["GET", "/api/artifacts"],
    ["GET", `/api/artifacts/${artifact.id}/content`],
    ["DELETE", `/api/artifacts/${artifact.id}`],
  ] as const) {
    const denied = await workerApp.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
      },
      env,
    );
    expect(denied.status).toBe(401);
  }
});
