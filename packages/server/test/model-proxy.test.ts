// SPDX-License-Identifier: Apache-2.0

import type { CapabilityScope } from "@opa/db/capability-tokens";
import type { LedgerCall } from "@opa/db/repository";
import { SseParser } from "@opa/providers";
import { describe, expect, it, vi } from "vitest";
import { Limits } from "../src/limits";
import { ModelProxy, type ProxyProvider, proxyRequest } from "../src/model-proxy";

const MODEL = "gpt-4o-mini";
const SCOPE: CapabilityScope = {
  tokenId: "token-row",
  userId: "alice",
  taskId: "task",
  computerId: "computer",
  aud: "model_proxy",
  expiresAt: Date.now() + 60_000,
  modelAllowlist: [{ providerId: "saved-provider", model: MODEL }],
};
const BODY = { model: MODEL, messages: [{ role: "user", content: "hello" }] };

function fixture(
  api: ProxyProvider["api"] = "openai-chat",
  hooks: {
    verify?: () => Promise<undefined | false>;
    record?: () => Promise<void>;
    atomicError?: () => void;
  } = {},
) {
  const stored = new Map<string, unknown>();
  const kv = {
    get: <T>(key: string) => structuredClone(stored.get(key)) as T | undefined,
    put: <T>(key: string, value: T) => {
      stored.set(key, structuredClone(value));
    },
  };
  const limits = new Limits(kv);
  limits.startTask("task", 5_000);
  let live = true;
  let billingId = "openai";
  let expiresAt = Date.now() + 60_000;
  let revokeDuringReserve = false;
  let configured = true;
  let verifyError = false;
  let resolveError = false;
  let fetchError = false;
  let recordError = false;
  let reserveError = false;
  const reservations: LedgerCall[] = [];
  let ceiling: CapabilityScope["modelAllowlist"] = SCOPE.modelAllowlist;
  const calls: { url: string; init: RequestInit }[] = [];
  const ledger: { taskId: string; usage: unknown }[] = [];
  let upstream = async (_init: RequestInit) =>
    new Response(
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }),
      { headers: { "content-type": "application/json", "set-cookie": "bad=1" } },
    );
  let queue = Promise.resolve();
  const proxy = new ModelProxy({
    userId: "alice",
    limits,
    journal: kv,
    atomic: <T>(fn: () => Promise<T>) => {
      const next = queue.then(fn).catch((error: unknown) => {
        hooks.atomicError?.();
        throw error;
      });
      queue = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    verify: async () => {
      const verified = await hooks.verify?.();
      if (verifyError) throw new Error("store down");
      return live && verified !== false ? { ...SCOPE, expiresAt, modelAllowlist: ceiling } : null;
    },
    resolve: async () => {
      if (resolveError) throw new Error("vault down");
      return configured ? { ...provider, api, billingId } : null;
    },
    reserve: async (call) => {
      if (reserveError) throw new Error("ledger reserve failed");
      reservations.push(call);
      if (revokeDuringReserve) live = false;
    },
    record: async (call) => {
      await hooks.record?.();
      if (recordError) throw new Error("ledger down");
      ledger.push(call);
    },
    fetch: ((url, init) => {
      if (fetchError) throw new Error("fetch setup failed");
      calls.push({ url: String(url), init: init ?? {} });
      return upstream(init ?? {});
    }) as typeof fetch,
  });
  const send = (body: unknown = BODY) =>
    proxy.call(
      "opaque-token",
      "saved-provider",
      api === "anthropic-messages"
        ? "/messages"
        : api === "openai-responses"
          ? "/responses"
          : "/chat/completions",
      body,
    );
  return {
    proxy,
    send,
    calls,
    ledger,
    limits,
    stored,
    reservations,
    failReserve: () => {
      reserveError = true;
    },
    unpriced: () => {
      billingId = "unknown";
    },
    expire: () => {
      expiresAt = Date.now() - 1;
    },
    revokeOnReserve: () => {
      revokeDuringReserve = true;
    },
    revoke: () => {
      live = false;
    },
    removeConfig: () => {
      configured = false;
    },
    nullCeiling: () => {
      ceiling = null;
    },
    upstream: (fn: typeof upstream) => {
      upstream = fn;
    },
    failVerify: () => {
      verifyError = true;
    },
    failResolve: () => {
      resolveError = true;
    },
    failFetch: () => {
      fetchError = true;
    },
    failRecord: (fail: boolean) => {
      recordError = fail;
    },
  };
}

describe("atomic model proxy calls", () => {
  it.each(["unpriced", "expired", "revoked-during-ledger"])(
    "makes zero upstream calls when %s",
    async (why) => {
      const f = fixture();
      if (why === "unpriced") f.unpriced();
      if (why === "expired") f.expire();
      if (why === "revoked-during-ledger") f.revokeOnReserve();
      expect((await f.send()).status).toBe(why === "unpriced" ? 409 : 401);
      expect(f.calls).toHaveLength(0);
      expect(f.limits.totals().heldMicroUsd).toBe(0);
      expect(f.limits.totals().todayMicroUsd).toBe(0);
    },
  );

  it("persists a task ledger reservation before making an upstream request", async () => {
    const f = fixture();
    f.upstream(async () => {
      expect(f.reservations).toEqual([expect.objectContaining({ taskId: "task", model: MODEL })]);
      return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 20 } });
    });
    const response = await f.send();
    await response.text();
    expect(f.reservations).toHaveLength(1);
    expect(f.ledger).toHaveLength(1);
  });

  it("makes zero upstream calls when the reservation ledger write fails", async () => {
    const f = fixture();
    f.failReserve();
    expect((await f.send()).status).toBe(503);
    expect(f.calls).toHaveLength(0);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
  });

  it("settles an evicted task's journal on cancellation even without another request", async () => {
    const f = fixture();
    const id = "proxy-evicted";
    const hold = f.limits.reserveFor(id, "openai", MODEL, 400, 0, { taskId: "task" });
    expect(hold).toHaveProperty("reservedMicroUsd");
    f.stored.set("model-proxy:pending", {
      [id]: {
        id,
        taskId: "task",
        providerId: "openai",
        model: MODEL,
        ceiling: { inputTokens: 200, outputTokens: 4096, cachedInputTokens: 0 },
      },
    });
    await f.proxy.cancelTask("task");
    expect(f.limits.totals().heldMicroUsd).toBe(0);
    expect(f.ledger).toHaveLength(1);
  });

  it.each(["verify", "resolve"])("fails closed if %s storage is unavailable", async (which) => {
    const f = fixture();
    if (which === "verify") f.failVerify();
    else f.failResolve();
    expect((await f.send()).status).toBe(401);
    expect(f.calls).toHaveLength(0);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
  });

  it("settles a synchronous fetch failure without leaking a hold", async () => {
    const f = fixture();
    f.failFetch();
    expect((await f.send()).status).toBe(502);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
    expect(f.ledger).toHaveLength(1);
  });

  it("repairs a failed ledger insert before the next admission without billing twice", async () => {
    const f = fixture();
    f.failRecord(true);
    const response = await f.send();
    await expect(response.text()).rejects.toThrow();
    const charged = f.limits.totals().todayMicroUsd;
    f.failRecord(false);
    f.revoke();
    expect((await f.send()).status).toBe(401);
    expect(f.ledger).toHaveLength(1);
    expect(f.limits.totals().todayMicroUsd).toBe(charged);
    expect(f.stored.get("model-proxy:pending")).toEqual({});
  });

  it("charges the reservation when a stream ends without terminal usage", async () => {
    const f = fixture();
    f.upstream(
      async () =>
        new Response(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const response = await f.send();
    const held = f.limits.totals().heldMicroUsd;
    await response.text();
    expect(f.limits.totals().todayMicroUsd).toBe(held);
  });

  it.each(["revoked", "storage-failure"])(
    "rechecks %s liveness without waiting for upstream bytes or client reads",
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      try {
        f.upstream(
          async () =>
            new Response(new ReadableStream(), {
              headers: { "content-type": "text/event-stream" },
            }),
        );
        const response = await f.send();
        if (reason === "revoked") f.revoke();
        else f.failVerify();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(f.calls[0]?.init.signal?.aborted).toBe(true);
        await expect(response.text()).rejects.toThrow();
        expect(f.limits.totals().heldMicroUsd).toBe(0);
        expect(f.ledger).toHaveLength(1);
      } finally {
        await f.proxy.cancelTask("task");
        vi.useRealTimers();
      }
    },
  );

  it.each(["verify", "record"])(
    "contains liveness %s failures without interrupting another call or rejecting an atomic callback",
    async (failure) => {
      vi.useFakeTimers();
      let failNextVerify = false;
      const atomicError = vi.fn();
      const f = fixture("openai-chat", {
        verify: async () => {
          if (failNextVerify) {
            failNextVerify = false;
            if (failure === "record") return false;
            throw new Error("transient verification failure");
          }
        },
        atomicError,
      });
      try {
        f.upstream(
          async () =>
            new Response(new ReadableStream(), {
              headers: { "content-type": "text/event-stream" },
            }),
        );
        const first = await f.send();
        const second = await f.send();
        failNextVerify = true;
        f.failRecord(failure === "record");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(atomicError).not.toHaveBeenCalled();
        expect(f.calls[0]?.init.signal?.aborted).toBe(true);
        expect(f.calls[1]?.init.signal?.aborted).toBe(false);
        await expect(first.text()).rejects.toThrow();
        f.failRecord(false);
        await f.proxy.cancelTask("task");
        await expect(second.text()).rejects.toThrow();
        expect(f.limits.totals().heldMicroUsd).toBe(0);
      } finally {
        f.failRecord(false);
        await f.proxy.cancelTask("task");
        vi.useRealTimers();
      }
    },
  );

  it("admits another call while a periodic liveness read is stalled", async () => {
    vi.useFakeTimers();
    let pauseNextVerify = false;
    let releaseVerify: () => void = () => {};
    const verifyPending = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const f = fixture("openai-chat", {
      verify: async () => {
        if (!pauseNextVerify) return;
        pauseNextVerify = false;
        await verifyPending;
      },
    });
    let second: Promise<Response> | undefined;
    try {
      f.upstream(
        async () =>
          new Response(new ReadableStream(), {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const first = await f.send();
      pauseNextVerify = true;
      await vi.advanceTimersByTimeAsync(1_000);
      second = f.send();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(2);
      expect(f.calls[0]?.init.signal?.aborted).toBe(false);
      releaseVerify();
      const response = await second;
      await f.proxy.cancelTask("task");
      await expect(first.text()).rejects.toThrow();
      await expect(response.text()).rejects.toThrow();
      expect(f.ledger).toHaveLength(2);
      expect(f.limits.totals().heldMicroUsd).toBe(0);
    } finally {
      releaseVerify();
      await second;
      await f.proxy.cancelTask("task");
      vi.useRealTimers();
    }
  });

  it("ignores a failed liveness check once successful settlement has started", async () => {
    vi.useFakeTimers();
    let rejectVerify: (error: Error) => void = () => {};
    let releaseRecord: () => void = () => {};
    let enteredVerify: () => void = () => {};
    let enteredRecord: () => void = () => {};
    const verifyEntered = new Promise<void>((resolve) => {
      enteredVerify = resolve;
    });
    const recordEntered = new Promise<void>((resolve) => {
      enteredRecord = resolve;
    });
    const verifyPending = new Promise<void>((_resolve, reject) => {
      rejectVerify = reject;
    });
    const recordPending = new Promise<void>((resolve) => {
      releaseRecord = resolve;
    });
    let pause = false;
    const f = fixture("openai-chat", {
      verify: async () => {
        if (!pause) return;
        enteredVerify();
        await verifyPending;
      },
      record: async () => {
        enteredRecord();
        await recordPending;
      },
    });
    try {
      let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
      f.upstream(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                upstream = controller;
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      const response = await f.send();
      const reading = response.text().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      pause = true;
      await vi.advanceTimersByTimeAsync(1_000);
      await verifyEntered;
      const payload = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 20 } });
      upstream?.enqueue(new TextEncoder().encode(payload));
      upstream?.close();
      await recordEntered;
      rejectVerify(new Error("verification failed after EOF"));
      await vi.advanceTimersByTimeAsync(0);
      releaseRecord();
      expect(await reading).toEqual({ value: payload });
      expect(f.calls[0]?.init.signal?.aborted).toBe(false);
      expect(f.ledger).toHaveLength(1);
    } finally {
      rejectVerify(new Error("test cleanup"));
      releaseRecord();
      await f.proxy.cancelTask("task");
      vi.useRealTimers();
    }
  });

  it.each(["\n", "\n\n", "\r\r", "\r\n\r\n"])(
    "forwards sanitized SSE heartbeats with %j without waiting for data",
    async (eol) => {
      const f = fixture();
      f.upstream(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`: keepalive ${provider.apiKey}${eol}`),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const response = await f.send();
      const reader = response.body?.getReader();
      const reading = reader?.read();
      let received = false;
      void reading?.then(
        () => {
          received = true;
        },
        () => {},
      );
      try {
        await vi.waitFor(() => expect(received).toBe(true), { timeout: 1_000, interval: 5 });
        expect(new TextDecoder().decode((await reading)?.value)).toBe(": heartbeat\n\n");
      } finally {
        await reader?.cancel();
        await reading?.catch(() => {});
      }
    },
  );

  it("preserves empty SSE data events without aborting inference", async () => {
    const f = fixture();
    f.upstream(
      async () =>
        new Response(
          'data:\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await f.send();
    await expect(response.text()).resolves.toContain("data: [DONE]");
    expect(f.calls[0]?.init.signal?.aborted).toBe(false);
    expect(f.ledger[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 });
  });

  it.each(["json", "sse", "json-escaped", "sse-escaped"])(
    "redacts credentials in chunked successful %s error bodies",
    async (format) => {
      const f = fixture();
      const payload = JSON.stringify({ error: { message: `invalid key: ${provider.apiKey}` } });
      const json = format.endsWith("escaped")
        ? payload.replace("provider", "\\u0070rovider")
        : payload;
      const sse = format.startsWith("sse");
      const wire = sse ? `event: error\ndata: ${json}\n\n` : json;
      f.upstream(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of new TextEncoder().encode(wire))
                  controller.enqueue(new Uint8Array([byte]));
                controller.close();
              },
            }),
            {
              headers: {
                "content-type": sse ? "text/event-stream" : "application/json",
              },
            },
          ),
      );
      const text = await (await f.send()).text();
      expect(text).not.toContain(provider.apiKey);
      expect(text).toContain("[redacted]");
      if (sse) expect(text).toContain("event: error");
    },
  );

  it.each(["\n", "\r", "\r\n"])(
    "keeps SSE event names on one line with %j separators and redacts literal keys",
    async (eol) => {
      const f = fixture();
      const escapedKey = provider.apiKey.replace("provider", "\\u0070rovider");
      const event = `message\\ndata: ${escapedKey}`;
      const payload = {
        text: "first\nsecond",
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      };
      const wire = [
        `event: ${event}`,
        `id: ${escapedKey}`,
        `data: ${JSON.stringify(payload)}`,
        "",
        `event: ${provider.apiKey}`,
        "data: [DONE]",
        "",
        "",
      ].join(eol);
      f.upstream(
        async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
      );
      const downstream = await (await f.send()).text();
      expect(downstream).not.toContain(provider.apiKey);
      const events = new SseParser().push(downstream, true);
      expect(events).toEqual([
        { event, data: JSON.stringify(payload) },
        { event: "[redacted]", data: "[DONE]" },
      ]);
      expect(JSON.parse(events[0]?.data ?? "null")).toEqual(payload);
    },
  );

  it.each(["\n", "\r", "\r\n"])(
    "settles only complete multiline SSE events with %j separators",
    async (eol) => {
      const f = fixture();
      const wire = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,',
        'data: "cache_read_input_tokens":4,"cache_creation_input_tokens":2,"output_tokens":0}}}',
        "",
        'data: {"type":"message_delta","usage":{"input_tokens":null,"output_tokens":20}}',
        "",
        'data: {"type":"message_stop"}',
        "",
        "",
      ].join(eol);
      f.upstream(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of new TextEncoder().encode(wire))
                  controller.enqueue(new Uint8Array([byte]));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const downstream = await (await f.send()).text();
      const events = new SseParser().push(downstream, true);
      expect(events.map((event) => JSON.parse(event.data))).toEqual([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
              output_tokens: 0,
            },
          },
        },
        { type: "message_delta", usage: { input_tokens: null, output_tokens: 20 } },
        { type: "message_stop" },
      ]);
      expect(f.ledger[0]?.usage).toEqual({
        inputTokens: 16,
        outputTokens: 20,
        cachedInputTokens: 0,
      });
    },
  );

  it("retains independent cumulative input/cache fields across partial usage updates", async () => {
    const f = fixture();
    const wire = [
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "message_delta", usage: { cache_read_input_tokens: 4, input_tokens: null } },
      {
        type: "message_delta",
        usage: { cache_creation_input_tokens: 2, cache_read_input_tokens: null },
      },
      { type: "message_delta", usage: { input_tokens: 12, output_tokens: 20 } },
      { type: "message_delta", usage: { input_tokens: 10, output_tokens: null } },
      { type: "message_stop" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    f.upstream(
      async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    );
    await (await f.send()).text();
    expect(f.ledger[0]?.usage).toEqual({ inputTokens: 18, outputTokens: 20, cachedInputTokens: 0 });
  });

  it.each([
    ["response.completed", undefined],
    ["response.incomplete", "content_filter"],
    ["response.incomplete", "max_output_tokens"],
  ])("settles final Responses usage for %s (%s)", async (type, reason) => {
    const f = fixture("openai-responses");
    const event = {
      type,
      response: {
        status: type === "response.completed" ? "completed" : "incomplete",
        incomplete_details: reason ? { reason } : null,
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    };
    f.upstream(
      async () =>
        new Response(`data: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    await (await f.send({ model: MODEL, input: "hello", stream: true })).text();
    expect(f.ledger[0]?.usage).toEqual({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 });
    expect(f.limits.totals().heldMicroUsd).toBe(0);
  });

  it.each([
    ["unterminated", { input_tokens: 10, output_tokens: 20 }],
    ["nonterminal", { input_tokens: 10, output_tokens: 20 }],
    ["missing output", { input_tokens: 10 }],
    ["negative input", { input_tokens: -1, output_tokens: 20 }],
    ["invalid output", { input_tokens: 10, output_tokens: "20" }],
    ["over ceiling", { input_tokens: 10, output_tokens: 999999 }],
    ["malformed", { input_tokens: 10, output_tokens: 20 }],
  ])("charges the reservation for %s Responses usage", async (why, usage) => {
    const f = fixture("openai-responses");
    const event = {
      type: why === "nonterminal" ? "response.in_progress" : "response.incomplete",
      response: { usage },
    };
    const json = JSON.stringify(event);
    const wire =
      why === "malformed"
        ? `data: ${json.slice(0, -1)}\n\n`
        : `data: ${json}${why === "unterminated" ? "" : "\n\n"}`;
    f.upstream(
      async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }),
    );
    const response = await f.send({ model: MODEL, input: "hello", stream: true });
    const held = f.limits.totals().heldMicroUsd;
    if (why === "malformed") await expect(response.text()).rejects.toThrow();
    else await response.text();
    expect(f.ledger[0]?.usage).toEqual(expect.objectContaining({ outputTokens: 4096 }));
    expect(f.limits.totals().todayMicroUsd).toBe(held);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
  });

  it.each(["json", "sse"])(
    "fails closed on oversized %s response frames and releases the hold",
    async (format) => {
      const f = fixture();
      const large = JSON.stringify({ error: { message: "x".repeat(1024 * 1024) } });
      f.upstream(
        async () =>
          new Response(format === "sse" ? `data: ${large}\n\n` : large, {
            headers: {
              "content-type": format === "sse" ? "text/event-stream" : "application/json",
            },
          }),
      );
      await expect((await f.send()).text()).rejects.toThrow();
      expect(f.calls[0]?.init.signal?.aborted).toBe(true);
      expect(f.limits.totals().heldMicroUsd).toBe(0);
      expect(f.ledger).toHaveLength(1);
    },
  );

  it("does not accept an unterminated terminal event at EOF", async () => {
    const f = fixture();
    f.upstream(
      async () =>
        new Response(
          'data: {"usage":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await f.send();
    const held = f.limits.totals().heldMicroUsd;
    expect(await response.text()).not.toContain("[DONE]");
    expect(f.limits.totals().todayMicroUsd).toBe(held);
  });

  it("injects only provider credentials and settles a task-attributed call", async () => {
    const f = fixture();
    const response = await f.send();
    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(false);
    await response.text();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer provider-key-canary",
    });
    expect(f.calls[0]?.init.redirect).toBe("manual");
    expect(f.ledger).toEqual([
      expect.objectContaining({
        taskId: "task",
        usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 },
      }),
    ]);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
  });

  it.each(["revoked", "wrong-model", "removed-config", "null-ceiling", "over-budget"])(
    "makes zero upstream calls when %s",
    async (why) => {
      const f = fixture();
      if (why === "revoked") f.revoke();
      if (why === "removed-config") f.removeConfig();
      if (why === "null-ceiling") f.nullCeiling();
      if (why === "over-budget") f.limits.endTask("task");
      const res = await f.send(why === "wrong-model" ? { ...BODY, model: "gpt-4o" } : BODY);
      expect(res.status).toBe(why === "over-budget" ? 429 : 401);
      expect(f.calls).toHaveLength(0);
      expect(f.limits.totals().heldMicroUsd).toBe(0);
    },
  );

  it("serializes concurrent admissions against one live task budget", async () => {
    const f = fixture();
    f.upstream(
      async () =>
        new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
    );
    const results = await Promise.all(Array.from({ length: 10 }, () => f.send()));
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.length).toBeLessThan(10);
    expect(results.some((r) => r.status === 429)).toBe(true);
    expect(f.limits.totals().heldMicroUsd).toBeLessThanOrEqual(5_000);
    await f.proxy.cancelTask("task");
    expect(f.limits.totals().heldMicroUsd).toBe(0);
    expect(f.ledger).toHaveLength(f.calls.length);
  });

  it("propagates a client disconnect as an AbortError and settles the upstream reservation", async () => {
    const f = fixture();
    f.upstream(
      async () =>
        new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } }),
    );
    const client = new AbortController();
    const response = await f.proxy.call(
      "opaque-token",
      "saved-provider",
      "/chat/completions",
      BODY,
      client.signal,
    );
    const reading = response.text().catch((error: Error) => error);
    client.abort();
    expect(await reading).toMatchObject({ name: "AbortError" });
    // Join the same in-flight settlement, without depending on microtask timing.
    await f.proxy.cancelTask("task");
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
    expect(f.ledger).toHaveLength(1);
  });

  it("aborts a streaming upstream on cancel, settles once, and refuses the next call", async () => {
    const f = fixture();
    let cancelled = false;
    f.upstream(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );
    const response = await f.send();
    const reading = response.text().catch(() => "aborted");
    f.revoke();
    await f.proxy.cancelTask("task");
    expect(await reading).toBe("aborted");
    expect(cancelled).toBe(true);
    expect(f.calls[0]?.init.signal?.aborted).toBe(true);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
    expect(f.ledger).toHaveLength(1);
    await f.proxy.cancelTask("task");
    expect((await f.send()).status).toBe(401);
    expect(f.calls).toHaveLength(1);
    expect(f.ledger).toHaveLength(1);
  });

  it("never follows a redirect or returns its credential-bearing body or headers", async () => {
    const f = fixture();
    f.upstream(
      async () =>
        new Response("provider-key-canary", {
          status: 307,
          headers: { location: "https://elsewhere.example" },
        }),
    );
    const response = await f.send();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("provider-key-canary");
    expect(response.headers.has("location")).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
  });
});

describe.each([
  ["openai-chat", "max_tokens"],
  ["openai-responses", "max_output_tokens"],
  ["anthropic-messages", "max_tokens"],
] as const)("%s bounded reservations", (api, outputKey) => {
  it.each([0, -1])(
    "checks the combined one-token rounding boundary at budget offset %i",
    async (offset) => {
      const f = fixture(api);
      const body =
        api === "openai-responses"
          ? { model: MODEL, input: "xxxxxxx", max_output_tokens: 1 }
          : { ...BODY, messages: [{ role: "user", content: "hello!!" }], max_tokens: 1 };
      // Responses: ceil(1087 * .15 + .60) = 164; Messages/Chat: ceil(1367 * .15 + .60) = 206.
      const cost = api === "openai-responses" ? 164 : 206;
      f.limits.endTask("task");
      f.limits.startTask("task", cost + offset);
      f.upstream(async () => Response.json({}));
      const response = await f.send(body);
      try {
        expect(response.status).toBe(offset === 0 ? 200 : 429);
        if (offset === 0) {
          expect(f.limits.totals().heldMicroUsd).toBe(cost);
          expect(f.reservations[0]?.usage?.outputTokens).toBe(1);
          await response.text();
          expect(f.limits.totals().todayMicroUsd).toBe(cost);
        } else {
          expect(f.reservations).toHaveLength(0);
          expect(f.calls).toHaveLength(0);
          expect(f.limits.heldIds()).toEqual([]);
        }
      } finally {
        await f.proxy.cancelTask("task");
      }
    },
  );

  it.each([false, true])(
    "uses the live budget ceiling with an existing hold: %s",
    async (active) => {
      const f = fixture(api);
      const body =
        api === "openai-responses"
          ? { model: MODEL, input: [{ role: "user", content: "hello!!!!!!" }] }
          : { ...BODY, messages: [{ role: "user", content: "hello!!!" }] };
      f.limits.endTask("task");
      f.limits.startTask("task", active ? 592 : 386);
      f.upstream(async () => Response.json({}));
      const first = active ? await f.send({ ...body, max_tokens: 1 }) : undefined;
      const response = await f.send({ ...body, max_tokens: 500 });
      try {
        expect(response.status).toBe(200);
        if (first) expect(first.status).toBe(200);
        const index = active ? 1 : 0;
        const ceiling = { inputTokens: 1370, outputTokens: 300, cachedInputTokens: 0 };
        expect(JSON.parse(String(f.calls[index]?.init.body))[outputKey]).toBe(300);
        expect(f.reservations[index]?.usage).toEqual(ceiling);
        expect(f.stored.get("model-proxy:pending")).toMatchObject({
          [String(f.reservations[index]?.id)]: { ceiling },
        });
        expect(f.limits.totals().heldMicroUsd).toBe(active ? 592 : 386);
        await response.text();
        expect(f.ledger[0]?.usage).toEqual(ceiling);
        expect(f.limits.totals().todayMicroUsd).toBe(386);
        expect(f.limits.totals().heldMicroUsd).toBe(active ? 206 : 0);
        if (first) await first.text();
      } finally {
        await f.proxy.cancelTask("task");
      }
    },
  );

  it.each([
    [{ max_tokens: 1 }, 1],
    [{ max_completion_tokens: 16 }, 16],
    [{ max_output_tokens: 255 }, 255],
    [{ max_tokens: 100, max_completion_tokens: 16, max_output_tokens: 50 }, 16],
    [{ max_tokens: 1, max_completion_tokens: 500, max_output_tokens: 10 }, 1],
    [{ max_tokens: 999999 }, 4096],
    [{}, 4096],
  ])("holds and journals the actual ceiling for %j", async (caps, expected) => {
    const f = fixture(api);
    f.upstream(async () => Response.json({}));
    const response = await f.send({ ...BODY, ...caps });
    try {
      expect(response.status).toBe(200);
      expect(JSON.parse(String(f.calls[0]?.init.body))[outputKey]).toBe(expected);
      expect(f.reservations).toEqual([
        expect.objectContaining({ usage: expect.objectContaining({ outputTokens: expected }) }),
      ]);
      const ceiling = f.reservations[0]?.usage;
      expect(f.stored.get("model-proxy:pending")).toEqual({
        [String(f.reservations[0]?.id)]: expect.objectContaining({ ceiling }),
      });
      // gpt-4o-mini: 0.15 micro-USD/input token, 0.60/output token.
      const held = Math.ceil((ceiling?.inputTokens ?? 0) * 0.15 + Number(expected) * 0.6);
      expect(f.limits.totals().heldMicroUsd).toBe(held);
      await response.text();
      expect(f.limits.totals()).toEqual({
        todayMicroUsd: held,
        monthMicroUsd: held,
        heldMicroUsd: 0,
      });
      expect(f.ledger[0]?.usage).toEqual(ceiling);
      expect(f.limits.task("task")?.spentMicroUsd).toBe(held);
    } finally {
      await f.proxy.cancelTask("task");
    }
  });

  it.each(["task_budget", "daily", "monthly_hard"] as const)(
    "admits an affordable one-token request under a tight %s limit",
    async (limit) => {
      const f = fixture(api);
      // The bounded input costs < 220 micro-USD; 256 output tokens would cost another 154.
      if (limit === "task_budget") {
        f.limits.endTask("task");
        f.limits.startTask("task", 240);
      }
      if (limit === "daily") f.limits.setSettings({ dailyCapMicroUsd: 240 });
      if (limit === "monthly_hard") f.limits.setSettings({ hardCapMicroUsd: 240 });
      f.upstream(async () => Response.json({}));
      const response = await f.send({ ...BODY, max_output_tokens: 1 });
      try {
        expect(response.status).toBe(200);
        expect(f.reservations[0]?.usage?.outputTokens).toBe(1);
        expect(f.limits.totals().heldMicroUsd).toBeLessThanOrEqual(240);
        await response.text();
        expect(f.ledger[0]?.usage).toMatchObject({ outputTokens: 1 });
      } finally {
        await f.proxy.cancelTask("task");
      }
    },
  );

  it.each(["missing", "malformed", "over-cap", "valid"])(
    "settles %s final usage against the small ceiling",
    async (kind) => {
      const f = fixture(api);
      const usage =
        kind === "missing"
          ? undefined
          : {
              input_tokens: 10,
              output_tokens: kind === "malformed" ? "1" : kind === "over-cap" ? 17 : 1,
            };
      const event =
        api === "anthropic-messages"
          ? { type: "message_delta", usage }
          : api === "openai-responses"
            ? { type: "response.completed", response: { usage } }
            : { usage };
      const terminal = api === "anthropic-messages" ? '{"type":"message_stop"}' : "[DONE]";
      f.upstream(
        async () =>
          new Response(`data: ${JSON.stringify(event)}\n\ndata: ${terminal}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const response = await f.send({ ...BODY, max_tokens: 16, stream: true });
      const held = f.limits.totals().heldMicroUsd;
      await response.text();
      expect(f.reservations[0]?.usage?.outputTokens).toBe(16);
      expect(f.ledger[0]?.usage).toEqual(
        kind === "valid"
          ? { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0 }
          : f.reservations[0]?.usage,
      );
      expect(f.limits.totals().todayMicroUsd).toBe(kind === "valid" ? 3 : held);
      expect(f.limits.totals().heldMicroUsd).toBe(0);
    },
  );

  it("recovers a failed small-cap cancellation settlement once", async () => {
    const f = fixture(api);
    f.upstream(
      async () =>
        new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const response = await f.send({ ...BODY, max_tokens: 1 });
    const reading = response.text().catch(() => "aborted");
    const held = f.limits.totals().heldMicroUsd;
    f.failRecord(true);
    await expect(f.proxy.cancelTask("task")).rejects.toThrow("ledger down");
    expect(await reading).toBe("aborted");
    f.failRecord(false);
    await f.proxy.cancelTask("task");
    await f.proxy.cancelTask("task");
    expect(f.ledger).toHaveLength(1);
    expect(f.ledger[0]?.usage).toMatchObject({ outputTokens: 1 });
    expect(f.limits.totals().todayMicroUsd).toBe(held);
    expect(f.limits.totals().heldMicroUsd).toBe(0);
    expect(f.stored.get("model-proxy:pending")).toEqual({});
  });

  it("serializes concurrent small-cap admissions without reserving phantom output", async () => {
    const f = fixture(api);
    f.limits.endTask("task");
    f.limits.startTask("task", 700);
    f.upstream(
      async () =>
        new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => f.send({ ...BODY, max_tokens: 1 })),
    );
    try {
      expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(2);
      expect(f.reservations).toHaveLength(3);
      expect(f.reservations.every((call) => call.usage?.outputTokens === 1)).toBe(true);
      expect(f.limits.totals().heldMicroUsd).toBeLessThanOrEqual(700);
    } finally {
      await f.proxy.cancelTask("task");
    }
    expect(f.ledger).toHaveLength(3);
    expect(f.limits.totals().todayMicroUsd).toBeLessThanOrEqual(700);
  });

  it.each(["max_tokens", "max_completion_tokens", "max_output_tokens"])(
    "rejects an invalid competing %s without any reservation",
    async (alias) => {
      const f = fixture(api);
      const response = await f.send({ ...BODY, max_tokens: 1, max_output_tokens: 1, [alias]: 0 });
      expect(response.status).toBe(400);
      expect(f.reservations).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
      expect(f.limits.heldIds()).toEqual([]);
    },
  );
});

const provider = {
  baseUrl: "https://api.example/v1",
  api: "openai-chat" as const,
  apiKey: "provider-key-canary",
};

describe("the model proxy inference surface", () => {
  it.each([undefined, false, true])(
    "forces Responses storage off when caller store is %j",
    async (store) => {
      const f = fixture("openai-responses");
      const input = [
        {
          type: "function_call",
          call_id: "call",
          name: "lookup",
          arguments: "{}",
          status: "completed",
        },
        { type: "function_call_output", call_id: "call", output: "done" },
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "hi", annotations: [] }],
        },
      ];
      const response = await f.send({
        model: MODEL,
        input,
        ...(store === undefined ? {} : { store }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.url).toBe("https://api.example/v1/responses");
      expect(JSON.parse(String(f.calls[0]?.init.body))).toMatchObject({ store: false, input });
      expect(f.ledger).toHaveLength(1);
    },
  );

  it.each([undefined, null, 7, "item_reference"])(
    "rejects Responses item references with type %j before dispatch",
    async (type) => {
      const f = fixture("openai-responses");
      const response = await f.send({
        model: MODEL,
        input: [{ id: "stored-context", ...(type === undefined ? {} : { type }) }],
      });
      expect(response.status).toBe(400);
      expect(f.calls).toHaveLength(0);
      expect(f.reservations).toHaveLength(0);
      expect(f.limits.totals().heldMicroUsd).toBe(0);
    },
  );

  it("accepts narrow inline Responses replay metadata only", () => {
    const input = [
      {
        type: "function_call",
        call_id: "call",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "hi", annotations: [] }],
      },
      { type: "function_call_output", call_id: "call", output: "done" },
    ];
    const request = (value: unknown) =>
      proxyRequest(
        { ...provider, api: "openai-responses" },
        "/responses",
        { model: MODEL, input: value },
        300,
      );
    expect(request(input)).not.toBeNull();
    expect(
      request([{ type: "message", id: "inline-message", role: "user", content: "hello" }]),
    ).not.toBeNull();
    expect(request([{ type: "function_call", status: "https://context.example" }])).toBeNull();
    expect(
      request([
        {
          type: "output_text",
          text: "hi",
          annotations: [{ type: "file_citation", file_id: "opaque" }],
        },
      ]),
    ).toBeNull();
    expect(request([{ type: "tool_use", status: "completed" }])).toBeNull();
  });
  it("accepts bounded function schemas without interpreting JSON-schema types as content", () => {
    expect(
      proxyRequest(
        provider,
        "/chat/completions",
        {
          ...BODY,
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                parameters: { type: "object", properties: { query: { type: "string" } } },
              },
            },
          ],
        },
        300,
      ),
    ).not.toBeNull();
  });

  it("fails closed on a malformed configured URL", () => {
    expect(
      proxyRequest({ ...provider, baseUrl: "not a URL" }, "/chat/completions", BODY, 300),
    ).toBeNull();
  });

  it.each([
    { messages: [{ role: "user", content: [{ image_url: { url: "https://image.example" } }] }] },
    { messages: [{ role: "user", content: "hello", audio: { id: "unbounded" } }] },
    { system: [{ type: "image", source: { type: "url", url: "https://image.example" } }] },
    { tools: [{ name: "unbounded", type: "computer_20251124" }] },
    { input: [{ type: "item_reference", id: "stored-context" }] },
  ])("rejects unbounded nested protocol fields", (extra) => {
    expect(proxyRequest(provider, "/chat/completions", { ...BODY, ...extra }, 300)).toBeNull();
  });

  it("builds only the configured inference URL and overwrites the output ceiling", () => {
    const request = proxyRequest(
      provider,
      "/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 999999,
        max_completion_tokens: 999999,
        stream: true,
      },
      300,
    );
    expect(request?.url).toBe("https://api.example/v1/chat/completions");
    expect(request?.body.max_tokens).toBe(300);
    expect(request?.body.max_completion_tokens).toBeUndefined();
    expect(request?.body.stream_options).toEqual({ include_usage: true });
  });

  it.each([
    ["https://api.openai.com/v1", "max_completion_tokens"],
    ["https://api.example/v1", "max_tokens"],
  ])("uses the configured chat host's output cap at %s", (baseUrl, outputKey) => {
    const request = proxyRequest(
      { ...provider, baseUrl },
      "/chat/completions",
      { ...BODY, max_tokens: 999999, max_completion_tokens: 999999, max_output_tokens: 999999 },
      300,
    );
    expect(request?.body[outputKey]).toBe(300);
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
      if (key !== outputKey) expect(request?.body[key]).toBeUndefined();
  });

  describe.each([
    ["openai-chat", "https://api.openai.com/v1", "/chat/completions", "max_completion_tokens"],
    ["openai-chat", "https://api.example/v1", "/chat/completions", "max_tokens"],
    ["openai-responses", "https://api.openai.com/v1", "/responses", "max_output_tokens"],
    ["anthropic-messages", "https://api.anthropic.com/v1", "/messages", "max_tokens"],
  ] as const)("%s output ceilings at %s", (api, baseUrl, path, outputKey) => {
    it.each([
      [16, 16],
      [999999, 300],
      [undefined, 300],
      [300, 300],
      [1, 1],
    ])("clamps caller cap %s to %s", (cap, expected) => {
      const request = proxyRequest(
        { ...provider, api, baseUrl },
        path,
        { ...BODY, ...(cap === undefined ? {} : { [outputKey]: cap }) },
        300,
      );
      expect(request?.body[outputKey]).toBe(expected);
      for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"])
        if (key !== outputKey) expect(request?.body[key]).toBeUndefined();
    });

    it.each(
      [0, -1, 1.5, "16", null, true, {}, [], Number.MAX_SAFE_INTEGER + 1].map((cap) => ({ cap })),
    )("rejects invalid caller cap $cap before dispatch", async ({ cap }) => {
      const f = fixture(api);
      const response = await f.proxy.call("opaque-token", "saved-provider", path, {
        ...BODY,
        [outputKey]: cap,
      });
      expect(response.status).toBe(400);
      expect(f.calls).toHaveLength(0);
      expect(f.reservations).toHaveLength(0);
    });
  });

  it("preserves the smallest cap when normalizing competing output aliases", () => {
    expect(
      proxyRequest(
        provider,
        "/chat/completions",
        { ...BODY, max_tokens: 100, max_completion_tokens: 16, max_output_tokens: 50 },
        300,
      )?.body.max_tokens,
    ).toBe(16);
  });

  it.each([
    { type: "auto" },
    { type: "any", disable_parallel_tool_use: true },
    { type: "none" },
    { type: "tool", name: "lookup", disable_parallel_tool_use: false },
  ])("accepts bounded Messages tool choice %j", (tool_choice) => {
    const request = proxyRequest(
      { ...provider, api: "anthropic-messages" },
      "/messages",
      { ...BODY, tool_choice },
      300,
    );
    expect(request?.body.tool_choice).toEqual(tool_choice);
  });

  it.each([
    ["openai-chat", "/chat/completions", "auto"],
    ["openai-chat", "/chat/completions", "required"],
    ["openai-chat", "/chat/completions", { type: "function", function: { name: "lookup" } }],
    ["openai-responses", "/responses", "none"],
    ["openai-responses", "/responses", { type: "function", name: "lookup" }],
  ] as const)("accepts %s function-only tool choice %j", (api, path, tool_choice) => {
    const request = proxyRequest({ ...provider, api }, path, { ...BODY, tool_choice }, 300);
    expect(request?.body.tool_choice).toEqual(tool_choice);
  });

  it.each([
    { type: "web_search" },
    { type: "auto", url: "https://content.example" },
    { type: "auto", disable_parallel_tool_use: "yes" },
    { type: "tool" },
    { type: "tool", name: 123 },
    { type: {} },
    { type: ["auto"] },
    { type: "tool", name: "lookup", function: { name: "lookup" } },
    "required",
  ])("rejects unsupported or malformed Messages tool choice %j", (tool_choice) => {
    expect(
      proxyRequest(
        { ...provider, api: "anthropic-messages" },
        "/messages",
        { ...BODY, tool_choice },
        300,
      ),
    ).toBeNull();
  });

  it.each([
    { type: "function", function: { name: "lookup", url: "https://content.example" } },
    { type: "function", function: { name: 123 } },
    { type: "function", name: "lookup" },
    { type: "web_search" },
    "tool",
    [],
    false,
  ])("rejects unsupported or malformed chat tool choice %j", (tool_choice) => {
    expect(proxyRequest(provider, "/chat/completions", { ...BODY, tool_choice }, 300)).toBeNull();
  });

  it("accounts for all inert function-argument JSON without resolving its contents", () => {
    const input = { document: { type: "file", url: "https://content.example/manual" } };
    const body = {
      ...BODY,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call", name: "lookup", input }] },
      ],
    };
    const request = proxyRequest(
      { ...provider, api: "anthropic-messages" },
      "/messages",
      body,
      300,
    );
    expect(request?.body.messages).toEqual(body.messages);
    expect(request?.inputTokens).toBe(
      new TextEncoder().encode(JSON.stringify(body)).byteLength + 1024 + 256,
    );
    expect(
      proxyRequest(
        { ...provider, api: "anthropic-messages" },
        "/messages",
        {
          ...body,
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", input: { text: "x".repeat(256 * 1024) } }],
            },
          ],
        },
        300,
      ),
    ).toBeNull();
  });

  it.each([
    "https://other.example/chat/completions",
    "//other.example/chat/completions",
    "/../chat/completions",
    "/%2e%2e/chat/completions",
    "/chat%2fcompletions",
    "/chat%252fcompletions",
    "/chat\\completions",
    "/chat//completions",
    "/models",
    "/files",
    "/chat/completions?key=secret",
    "/chat/completions#fragment",
  ])("refuses non-inference or ambiguous path %s", (path) => {
    expect(proxyRequest(provider, path, { model: "gpt-4o-mini", messages: [] }, 300)).toBeNull();
  });

  it.each([
    { n: 2 },
    { best_of: 2 },
    { tools: [{ type: "web_search" }] },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://image.example" } }],
        },
      ],
    },
    { previous_response_id: "a-large-stored-context" },
  ])("refuses payloads whose input or multiplicity is not bounded", (extra) => {
    expect(
      proxyRequest(
        provider,
        "/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
          ...extra,
        },
        300,
      ),
    ).toBeNull();
  });

  it("allows each provider's own inference endpoint only", () => {
    const body = { model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] };
    expect(
      proxyRequest({ ...provider, api: "anthropic-messages" }, "/messages", body, 280)?.body
        .max_tokens,
    ).toBe(280);
    expect(proxyRequest(provider, "/messages", body, 280)).toBeNull();
    expect(
      proxyRequest(
        { ...provider, api: "openai-responses" },
        "/responses",
        { model: "gpt-4o-mini", input: "hi" },
        280,
      )?.body.max_output_tokens,
    ).toBe(280);
  });
});
