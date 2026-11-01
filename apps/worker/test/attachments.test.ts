// SPDX-License-Identifier: Apache-2.0
// Attachments (M3-10 AC1–2): uploads stream to R2 under `u/{userId}/` with the type sniffed
// server-side, a file reaches the model only where its capability flags allow, and another
// user's file ID is a 404 on every route — the M3-21a isolation cases for these routes, landed
// here until that harness exists on `main`.
import { runInDurableObject } from "cloudflare:test";
import type {
  HarnessEvent,
  ModelCapabilities,
  ModelEvent,
  ModelMessage,
  ModelProvider,
} from "@opa/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Assistant, TURN_FILE_BYTES } from "../src/assistant";
import type { Env } from "../src/env";
import { workerApp } from "../src/worker-app";
import {
  Browser,
  claim,
  count,
  db,
  env,
  freshDatabase,
  ORIGIN,
  SOCKET_WAIT,
  sessionHeaders,
} from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const text = (value: string) => new TextEncoder().encode(value);

const cookieOf = (br: Browser) => [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

/** Uploads one file as the browser's user; `body` may be bytes or a chunked stream. */
function upload(
  br: Browser,
  name: string,
  body: Uint8Array | ReadableStream,
  bindings: Env = env,
  claimedType = "application/octet-stream",
) {
  const init = {
    method: "POST",
    headers: {
      cookie: cookieOf(br),
      origin: ORIGIN,
      "content-type": claimedType,
      "x-file-name": encodeURIComponent(name),
    },
    body,
  };
  return workerApp.request(`${ORIGIN}/api/attachments`, init as never, bindings);
}

const asUser = (headers: Record<string, string>, path: string, method = "GET") =>
  workerApp.request(`${ORIGIN}${path}`, { method, headers }, env);

interface Uploaded {
  id: string;
  name: string;
  mediaType: string;
  kind: string;
  sizeBytes: number;
}

describe("upload, serve, delete", () => {
  it("sniffs the type from the first bytes, stores under u/{userId}/ and serves it sandboxed", async () => {
    const { browser, owner } = await claim();
    // A PNG with a lying name and a lying Content-Type is still a PNG.
    const res = await upload(browser, "notes.txt", PNG, env, "text/plain");
    expect(res.status).toBe(201);
    const row = await res.json<Uploaded>();
    expect(row).toMatchObject({ mediaType: "image/png", kind: "image", sizeBytes: PNG.length });
    const stored = await env.FILES.get(`u/${owner}/attachments/${row.id}`);
    if (!stored) throw new Error("the object wasn't stored");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(PNG);

    const get = await asUser({ cookie: cookieOf(browser) }, `/api/attachments/${row.id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(get.headers.get("content-disposition")).toContain("inline");
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG);

    const del = await asUser(
      { cookie: cookieOf(browser), origin: ORIGIN },
      `/api/attachments/${row.id}`,
      "DELETE",
    );
    expect(del.status).toBe(204);
    expect(await env.FILES.head(`u/${owner}/attachments/${row.id}`)).toBeNull();
    expect((await asUser({ cookie: cookieOf(browser) }, `/api/attachments/${row.id}`)).status).toBe(
      404,
    );
  });

  it("streams a chunked body through without buffering it whole", async () => {
    const { browser, owner } = await claim();
    const chunk = new Uint8Array(8192).fill(0x61); // "a"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text("head,"));
        for (let i = 0; i < 32; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await upload(browser, "big.csv", body);
    expect(res.status).toBe(201);
    const row = await res.json<Uploaded>();
    expect(row.sizeBytes).toBe(5 + 32 * 8192);
    expect((await env.FILES.head(`u/${owner}/attachments/${row.id}`))?.size).toBe(row.sizeBytes);
  });

  it("refuses an unsupported type, an empty file and a file over the cap — and stores none of them", async () => {
    const { browser } = await claim();
    expect((await upload(browser, "setup.exe", MZ)).status).toBe(415);
    expect((await upload(browser, "empty.txt", new Uint8Array())).status).toBe(400);

    const small = { ...env, OPA_ATTACHMENT_MAX_BYTES: "16" };
    // Over the cap by Content-Length, refused up front…
    const declared = await upload(browser, "a.txt", text("x".repeat(64)), small);
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "too_large", maxBytes: 16 });
    // …and over the cap only mid-stream, stopped while streaming.
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text("12345678"));
        controller.enqueue(text("12345678"));
        controller.enqueue(text("12345678"));
        controller.close();
      },
    });
    expect((await upload(browser, "a.txt", streamed, small)).status).toBe(413);
    expect(await count("attachments")).toBe(0);
  });

  it("refuses a text file that turns binary past its first bytes, storing nothing", async () => {
    const { browser } = await claim();
    const listed = async () => (await env.FILES.list()).objects.length;
    const before = await listed();
    // Text through the sniff window, then an executable's bytes.
    const mixed = new Uint8Array([...text("a".repeat(600)), ...MZ]);
    expect((await upload(browser, "notes.txt", mixed)).status).toBe(415);
    // A character cut off at the very end is not text either.
    const cut = new Uint8Array([...text("b".repeat(600)), 0xe2, 0x82]);
    expect((await upload(browser, "notes.txt", cut)).status).toBe(415);
    expect(await count("attachments")).toBe(0);
    expect(await listed()).toBe(before);
    // Text to the end, past the window, still goes in.
    const long = text(`${"c".repeat(600)} — ✓\n`);
    expect((await upload(browser, "notes.txt", long)).status).toBe(201);
  });

  it("serves a PDF as a download, and config carries the cap and the type list", async () => {
    const { browser } = await claim();
    const res = await upload(browser, "bill.pdf", text("%PDF-1.7\n%%EOF"));
    const { id } = await res.json<Uploaded>();
    const get = await asUser({ cookie: cookieOf(browser) }, `/api/attachments/${id}`);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(get.headers.get("content-disposition")).toContain("attachment");

    const config = await asUser({ cookie: cookieOf(browser) }, "/api/attachments/config");
    expect(config.status).toBe(200);
    const body = await config.json<{ maxBytes: number; accept: string; model: unknown }>();
    expect(body.maxBytes).toBe(10 * 1024 * 1024);
    expect(body.accept).toContain(".png");
    expect(body.accept).toContain(".json");
    expect(body.model).toBeNull(); // no model set up yet
  });

  it("requires a session", async () => {
    await claim();
    const anon = new Browser();
    expect((await upload(anon, "a.txt", text("hi"))).status).toBe(401);
  });
});

describe("isolation (M3-21a cases for the attachment routes)", () => {
  it("answers 404 for another user's file on read and delete, and changes nothing", async () => {
    const { browser, owner } = await claim();
    const { id } = await (await upload(browser, "mine.txt", text("secret notes"))).json<Uploaded>();

    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')")
      .run();
    const other = await sessionHeaders("u2");
    expect((await asUser(other, `/api/attachments/${id}`)).status).toBe(404);
    expect((await asUser(other, `/api/attachments/${id}`, "DELETE")).status).toBe(404);
    // The owner's file is untouched.
    expect((await asUser({ cookie: cookieOf(browser) }, `/api/attachments/${id}`)).status).toBe(
      200,
    );
    expect(await env.FILES.head(`u/${owner}/attachments/${id}`)).not.toBeNull();
    // A traversal-flavoured ID never reaches a key.
    expect((await asUser(other, `/api/attachments/..%2F..%2F${owner}`)).status).toBe(404);
  });
});

/** A scripted model with the given capability flags, recording what it was asked. */
function scripted(seen: ModelMessage[][], caps: Partial<ModelCapabilities>): ModelProvider {
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: false, usageInStream: true, ...caps }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      seen.push(request.messages);
      yield { type: "text.delta", text: "Seen." };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));
function useModel(userId: string, provider: ModelProvider) {
  return runInDurableObject(assistantOf(userId), (instance: Assistant) => {
    instance.resolveModel = async () => ({ provider, model: "test-model", apiKey: null });
  });
}

async function openTab(br: Browser) {
  const res = await workerApp.request(
    `${ORIGIN}/api/chat`,
    { headers: { upgrade: "websocket", origin: ORIGIN, cookie: cookieOf(br) } },
    br.bindings,
  );
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) throw new Error(`socket failed: ${res.status}`);
  ws.accept();
  const events: HarnessEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
  const until = (type: HarnessEvent["type"]) =>
    vi.waitFor(() => expect(events.map((e) => e.type)).toContain(type), SOCKET_WAIT);
  const send = (conversationId: string, value: string, attachmentIds: string[] = []) =>
    ws.send(JSON.stringify({ type: "chat.send", conversationId, text: value, attachmentIds }));
  return { events, until, send };
}

const storedAttachments = async (br: Browser, conversationId: string) => {
  const res = await asUser(
    { cookie: cookieOf(br) },
    `/api/conversations/${conversationId}/messages`,
  );
  const { messages } = await res.json<{
    messages: { role: string; attachments: Record<string, unknown>[] }[];
  }>();
  return messages.flatMap((m) => m.attachments);
};

describe("the model receives a file only where its flags allow (AC2)", () => {
  it("keeps an image from a model without image input, and says so plainly", async () => {
    const { browser, owner } = await claim();
    const { id } = await (await upload(browser, "cat.png", PNG)).json<Uploaded>();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen, {}));
    const tab = await openTab(browser);
    tab.send("conv-1", "What is this?", [id]);
    await tab.until("turn.completed");

    expect(seen[0]?.at(-1)).toEqual({ role: "user", content: "What is this?" });
    const said = tab.events
      .filter((e) => e.type === "status")
      .map((e) => (e.payload as { text: string }).text);
    expect(said).toContain(
      "This model can't see images. I'll keep the file in Outputs, but it won't read it.",
    );
    // The file stays on the message, marked as not read.
    expect(await storedAttachments(browser, "conv-1")).toEqual([
      expect.objectContaining({ id, sentToModel: false }),
    ]);
  });

  it("sends the image to a model with image input, and a text file to any model", async () => {
    const { browser, owner } = await claim();
    const png = await (await upload(browser, "cat.png", PNG)).json<Uploaded>();
    const notes = await (
      await upload(browser, "notes.txt", text("the cat is called Bean"))
    ).json<Uploaded>();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen, { imageInput: true }));
    const tab = await openTab(browser);
    tab.send("conv-1", "", [png.id, notes.id]); // a send of files alone, no text
    await tab.until("turn.completed");

    const last = seen[0]?.at(-1) as Extract<ModelMessage, { role: "user" }>;
    expect(last.attachments).toEqual([
      {
        kind: "image",
        mediaType: "image/png",
        name: "cat.png",
        data: btoa(String.fromCharCode(...PNG)),
      },
      { kind: "text", mediaType: "text/plain", name: "notes.txt", text: "the cat is called Bean" },
    ]);
    expect(await storedAttachments(browser, "conv-1")).toEqual([
      expect.objectContaining({ id: png.id, sentToModel: true }),
      expect.objectContaining({ id: notes.id, sentToModel: true }),
    ]);
  });

  it("refuses a send naming a file that isn't the user's, writing nothing", async () => {
    const { browser, owner } = await claim();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen, { imageInput: true }));
    const tab = await openTab(browser);
    tab.send("conv-1", "hi", [crypto.randomUUID()]);
    await tab.until("turn.failed");
    expect(seen).toEqual([]);
    expect(await count("messages")).toBe(0);
  });
});

/** A PNG of `bytes` bytes: the signature, then padding the sniff never reads. */
const bigPng = (bytes: number) => {
  const file = new Uint8Array(bytes);
  file.set(PNG);
  return file;
};

/** A scripted model that reads images and records only the file names and sizes it was given. */
function filesSeen(seen: { name: string; length: number }[][]): ModelProvider {
  return {
    ...scripted([], { imageInput: true }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      seen.push(
        request.messages.flatMap((m) =>
          m.role === "user"
            ? (m.attachments ?? []).map((f) => ({
                name: f.name,
                length: f.data?.length ?? f.text?.length ?? 0,
              }))
            : [],
        ),
      );
      yield { type: "text.delta", text: "Seen." };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

describe("a long chat", () => {
  it("still loads with its files past D1's 100 bound parameters a query", async () => {
    const { browser, owner } = await claim();
    const { id } = await (await upload(browser, "notes.txt", text("hello"))).json<Uploaded>();
    await useModel(owner, scripted([], {}));
    const tab = await openTab(browser);
    tab.send("conv-long", "Read this", [id]);
    await tab.until("turn.completed");
    // 120 more messages: a lookup binding one parameter per message would fail on D1.
    const insert = db.prepare(
      `INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content)
       VALUES (?, ?, 'conv-long', ?, 'user', 'complete', 'more')`,
    );
    await db.batch(
      Array.from({ length: 120 }, (_, i) => insert.bind(crypto.randomUUID(), owner, 10 + i)),
    );
    expect(await storedAttachments(browser, "conv-long")).toEqual([
      expect.objectContaining({ id, sentToModel: true }),
    ]);
  });

  it("reloads a chat's files alongside its model-switch lines", async () => {
    const { browser, owner } = await claim();
    const { id } = await (await upload(browser, "notes.txt", text("hello"))).json<Uploaded>();
    await useModel(owner, scripted([], {}));
    const tab = await openTab(browser);
    tab.send("conv-mixed", "Read this", [id]);
    await tab.until("turn.completed");
    // A saved switch after the turn (TWO-614): a `system` row the chat shows but the model never sees.
    await db
      .prepare(
        `INSERT INTO messages (id, user_id, conversation_id, seq, role, status, content)
         VALUES ('switch-1', ?, 'conv-mixed', 99, 'system', 'complete', 'Switched to Other.')`,
      )
      .bind(owner)
      .run();
    const res = await asUser(
      { cookie: cookieOf(browser) },
      "/api/conversations/conv-mixed/messages",
    );
    const { messages } = await res.json<{
      messages: { id: string; role: string; attachments: Record<string, unknown>[] }[];
    }>();
    expect(messages.map((m) => [m.role, m.attachments.length])).toEqual([
      ["user", 1],
      ["assistant", 0],
      ["system", 0],
    ]);
    expect(messages[0]?.attachments[0]).toMatchObject({ id, sentToModel: true });
    expect(messages[2]).toMatchObject({ id: "switch-1", content: "Switched to Other." });
  });
});

describe("one turn's files stay within a byte budget", () => {
  const NINE_MB = 9 * 1024 * 1024;

  it("replays earlier turns' files newest first, only as far as the budget goes", async () => {
    const { browser, owner } = await claim();
    const ids: string[] = [];
    for (const name of ["a.png", "b.png", "c.png"])
      ids.push((await (await upload(browser, name, bigPng(NINE_MB))).json<Uploaded>()).id);
    const seen: { name: string; length: number }[][] = [];
    await useModel(owner, filesSeen(seen));
    const tab = await openTab(browser);
    const turns = [...ids.map((id) => [id]), []];
    for (const [i, files] of turns.entries()) {
      tab.send("conv-1", `turn ${i}`, files);
      await vi.waitFor(
        () => expect(tab.events.filter((e) => e.type === "turn.completed")).toHaveLength(i + 1),
        SOCKET_WAIT,
      );
    }
    // Each file is over half the budget, so a turn carries one: its own, or the newest earlier.
    expect(seen.map((files) => files.map((f) => f.name))).toEqual([
      ["a.png"],
      ["b.png"],
      ["c.png"],
      ["c.png"],
    ]);
    for (const files of seen)
      expect(files.reduce((n, f) => n + (f.length * 3) / 4, 0)).toBeLessThanOrEqual(
        TURN_FILE_BYTES,
      );
  });

  it("refuses a send whose own files are over the budget, writing nothing", async () => {
    const { browser, owner } = await claim();
    const a = await (await upload(browser, "a.png", bigPng(NINE_MB))).json<Uploaded>();
    const b = await (await upload(browser, "b.png", bigPng(NINE_MB))).json<Uploaded>();
    const seen: { name: string; length: number }[][] = [];
    await useModel(owner, filesSeen(seen));
    const tab = await openTab(browser);
    tab.send("conv-1", "both", [a.id, b.id]);
    await tab.until("turn.failed");
    expect(tab.events.at(-1)?.payload).toEqual({
      message: "Those files are too large to send in one message. Try fewer, or smaller, files.",
    });
    expect(seen).toEqual([]);
    expect(await count("messages")).toBe(0);
  });

  it("reads a long text file only as far as the model sees it", async () => {
    const { browser, owner } = await claim();
    const long = await (
      await upload(browser, "long.txt", new Uint8Array(1_000_000).fill(0x61))
    ).json<Uploaded>();
    const seen: ModelMessage[][] = [];
    await useModel(owner, scripted(seen, {}));
    const tab = await openTab(browser);
    tab.send("conv-1", "summarise", [long.id]);
    await tab.until("turn.completed");
    const last = seen[0]?.at(-1) as Extract<ModelMessage, { role: "user" }> | undefined;
    const [file] = last?.attachments ?? [];
    expect(file?.text).toBe(
      `${"a".repeat(100_000)}\n[Only the first part of this file is shown: it is long.]`,
    );
  });
});
