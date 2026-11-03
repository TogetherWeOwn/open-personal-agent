// SPDX-License-Identifier: Apache-2.0

import type { CapabilityScope } from "@opa/db/capability-tokens";
import { describe, expect, it } from "vitest";
import { Limits } from "../src/limits";
import { ModelProxy, proxyRequest } from "../src/model-proxy";

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

function fixture() {
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
  const reservations: unknown[] = [];
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
      const next = queue.then(fn);
      queue = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    verify: async () => {
      if (verifyError) throw new Error("store down");
      return live ? { ...SCOPE, expiresAt, modelAllowlist: ceiling } : null;
    },
    resolve: async () => {
      if (resolveError) throw new Error("vault down");
      return configured ? { ...provider, billingId } : null;
    },
    reserve: async (call: unknown) => {
      if (reserveError) throw new Error("ledger reserve failed");
      reservations.push(call);
      if (revokeDuringReserve) live = false;
    },
    record: async (call) => {
      if (recordError) throw new Error("ledger down");
      ledger.push(call);
    },
    fetch: ((url, init) => {
      if (fetchError) throw new Error("fetch setup failed");
      calls.push({ url: String(url), init: init ?? {} });
      return upstream(init ?? {});
    }) as typeof fetch,
  });
  const send = (body = BODY) =>
    proxy.call("opaque-token", "saved-provider", "/chat/completions", body);
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

const provider = {
  baseUrl: "https://api.example/v1",
  api: "openai-chat" as const,
  apiKey: "provider-key-canary",
};

describe("the model proxy inference surface", () => {
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
