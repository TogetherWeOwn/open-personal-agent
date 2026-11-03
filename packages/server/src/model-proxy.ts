// SPDX-License-Identifier: Apache-2.0
import type { CapabilityScope } from "@opa/db/capability-tokens";
import type { LedgerCall } from "@opa/db/repository";
import { findPrice } from "@opa/pricing";
import type { Kv, Limits } from "./limits";

interface ProxyDeps {
  userId: string;
  limits: Limits;
  journal: Kv;
  atomic<T>(fn: () => Promise<T>): Promise<T>;
  verify(token: string): Promise<CapabilityScope | null>;
  resolve(
    scope: CapabilityScope,
    providerId: string,
    model: string,
  ): Promise<(ProxyProvider & { billingId: string }) | null>;
  reserve(call: LedgerCall & { id: string; taskId: string }): Promise<void>;
  record(call: LedgerCall & { id: string; taskId: string }): Promise<void>;
  fetch: typeof fetch;
}

type Usage = NonNullable<LedgerCall["usage"]>;
interface PendingCall {
  id: string;
  taskId: string;
  providerId: string;
  model: string;
  ceiling: Usage;
  usage?: Usage;
}
interface ActiveCall {
  taskId: string;
  abort(): Promise<void>;
}
const JOURNAL = "model-proxy:pending";
const denied = () => Response.json({ error: "unauthenticated" }, { status: 401 });
const failure = (status: number, error: string) => Response.json({ error }, { status });

/** Admission runs under the root's DO gate; only the upstream stream runs outside it. */
export class ModelProxy {
  readonly #active = new Map<string, ActiveCall>();
  constructor(private readonly deps: ProxyDeps) {}

  #pending(): Record<string, PendingCall> {
    return this.deps.journal.get<Record<string, PendingCall>>(JOURNAL) ?? {};
  }

  async #settle(call: PendingCall, usage?: Usage): Promise<void> {
    const pending = this.#pending();
    if (!pending[call.id]) return;
    // Persist the final counts before either side effect: retrying after eviction settles the
    // hold and inserts the same ledger ID at most once, never losing a billed call.
    const final = { ...call, ...(usage ? { usage } : {}) };
    this.deps.journal.put(JOURNAL, { ...pending, [call.id]: final });
    this.deps.limits.settle(call.id, call.providerId, call.model, final.usage ?? null);
    await this.deps.record({ ...final, usage: final.usage ?? final.ceiling });
    const { [call.id]: _done, ...rest } = this.#pending();
    this.deps.journal.put(JOURNAL, rest);
  }

  async call(
    token: string,
    providerId: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const admitted = await this.deps.atomic(async () => {
      // A journal without a live controller belongs to an evicted call. Charge its whole hold
      // unless final usage was already persisted, and repair the ledger before admitting more.
      for (const call of Object.values(this.#pending())) {
        if (!this.#active.has(call.id)) await this.#settle(call, call.usage);
      }
      let scope: CapabilityScope | null;
      try {
        scope = await this.deps.verify(token);
      } catch {
        return denied();
      }
      if (
        scope?.aud !== "model_proxy" ||
        scope.userId !== this.deps.userId ||
        scope.expiresAt <= Date.now()
      )
        return denied();
      const model =
        body && typeof body === "object" ? (body as Record<string, unknown>).model : null;
      if (
        typeof model !== "string" ||
        !scope.modelAllowlist?.some(
          (pair) => pair?.providerId === providerId && pair.model === model,
        )
      )
        return denied();
      let provider: (ProxyProvider & { billingId: string }) | null;
      try {
        provider = await this.deps.resolve(scope, providerId, model);
      } catch {
        return denied();
      }
      if (!provider) return denied();
      const request = proxyRequest(provider, path, body, 4096);
      if (!request) return failure(400, "invalid_inference_request");
      const price = findPrice(provider.billingId, model);
      // Unlike interactive chat, a computer cannot draw an unpriced/unbounded reservation.
      if (!price || price.outputUsdPerMTok <= 0) return failure(409, "unpriced_model");
      // Resolve may decrypt a key or read configuration. Recheck the authoritative row after
      // those awaits, inside the same DO operation as the synchronous reserve and fetch start.
      let fresh: CapabilityScope | null;
      try {
        fresh = await this.deps.verify(token);
      } catch {
        return denied();
      }
      if (
        !fresh ||
        fresh.tokenId !== scope.tokenId ||
        fresh.userId !== scope.userId ||
        fresh.taskId !== scope.taskId ||
        fresh.expiresAt <= Date.now()
      )
        return denied();
      if (signal?.aborted) return failure(499, "cancelled");
      const id = `proxy-${crypto.randomUUID()}`;
      const reserved = this.deps.limits.reserveFor(
        id,
        provider.billingId,
        model,
        request.inputTokens * 2,
        0,
        {
          taskId: scope.taskId,
          background: true,
        },
      );
      if ("limit" in reserved) return failure(429, reserved.limit);
      const built = proxyRequest(provider, path, body, reserved.maxOutputTokens);
      if (!built) {
        this.deps.limits.release(id);
        return failure(400, "invalid_inference_request");
      }
      const call: PendingCall = {
        id,
        taskId: scope.taskId,
        providerId: provider.billingId,
        model,
        ceiling: {
          inputTokens: request.inputTokens,
          outputTokens: reserved.maxOutputTokens,
          cachedInputTokens: 0,
        },
      };
      this.deps.journal.put(JOURNAL, { ...this.#pending(), [id]: call });
      const unused: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      try {
        await this.deps.reserve({ ...call, usage: call.ceiling });
      } catch {
        // The insert may have landed before its acknowledgement was lost. Persist a zero-cost
        // settlement intent and release locally; recovery repairs that same ledger ID.
        await this.#settle(call, unused).catch(() => {});
        return failure(503, "ledger_unavailable");
      }
      try {
        fresh = await this.deps.verify(token);
      } catch {
        fresh = null;
      }
      if (
        !fresh ||
        fresh.tokenId !== scope.tokenId ||
        fresh.expiresAt <= Date.now() ||
        signal?.aborted
      ) {
        await this.#settle(call, unused);
        return denied();
      }
      const upstream = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let output: ReadableStreamDefaultController<Uint8Array> | undefined;
      let finished: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout>;
      let notifyAbort: () => void = () => {};
      const aborted = new Promise<null>((resolve) => {
        notifyAbort = () => resolve(null);
      });
      const finish = (usage?: Usage) => {
        if (finished) return finished;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        finished = this.#settle(call, usage).finally(() => this.#active.delete(id));
        return finished;
      };
      const abort = async () => {
        upstream.abort();
        notifyAbort();
        try {
          output?.error(new DOMException("cancelled", "AbortError"));
        } catch {}
        void reader?.cancel().catch(() => {});
        await finish();
      };
      const onAbort = () => {
        void abort().catch(() => {});
      };
      this.#active.set(id, { taskId: scope.taskId, abort });
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, Math.min(5 * 60_000, scope.expiresAt - Date.now()));
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (provider.api === "anthropic-messages") {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else headers.authorization = `Bearer ${provider.apiKey}`;
      // No incoming header, cookie, URL, query or redirect target reaches this fetch.
      let opening: Promise<Response | null>;
      try {
        opening = this.deps
          .fetch(built.url, {
            method: "POST",
            headers,
            body: JSON.stringify(built.body),
            redirect: "manual",
            signal: upstream.signal,
          })
          .catch(() => null);
      } catch {
        opening = Promise.resolve(null);
      }
      return {
        opening: Promise.race([opening, aborted]),
        upstream,
        finish,
        abort,
        call,
        setReader: (value: typeof reader) => {
          reader = value;
        },
        setOutput: (value: typeof output) => {
          output = value;
        },
      };
    });
    if (admitted instanceof Response) return admitted;
    const response = await admitted.opening;
    if (!response || admitted.upstream.signal.aborted || !response.ok || !response.body) {
      void response?.body?.cancel().catch(() => {});
      await admitted.finish();
      return failure(502, "upstream_failed");
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim();
    if (type !== "application/json" && type !== "text/event-stream") {
      await response.body.cancel();
      await admitted.finish();
      return failure(502, "upstream_failed");
    }
    const reader = response.body.getReader();
    admitted.setReader(reader);
    const usage = new ProxyUsage(type === "text/event-stream", admitted.call.ceiling);
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          admitted.setOutput(controller);
        },
        async pull(controller) {
          try {
            const next = await reader.read();
            if (admitted.upstream.signal.aborted) return;
            if (next.done) {
              await admitted.finish(usage.finish());
              controller.close();
            } else {
              usage.push(next.value);
              controller.enqueue(next.value);
            }
          } catch {
            await admitted.abort();
          }
        },
        cancel: () => admitted.abort(),
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { headers: { "content-type": type, "cache-control": "no-store" } });
  }

  /** Called after the cancel row/revocation write; serializes with all admission work. */
  async cancelTask(taskId: string): Promise<void> {
    await this.deps.atomic(async () => {
      for (const call of Object.values(this.#pending())) {
        if (call.taskId === taskId && !this.#active.has(call.id))
          await this.#settle(call, call.usage);
      }
      await Promise.all(
        [...this.#active.values()]
          .filter((call) => call.taskId === taskId)
          .map((call) => call.abort()),
      );
    });
  }
}

/** Only usage frames are inspected, with bounded buffering; prompts/replies never persist. */
class ProxyUsage {
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #usage: Usage | undefined;
  #disabled = false;
  #complete = false;
  constructor(
    private readonly sse: boolean,
    private readonly ceiling: Usage,
  ) {}
  push(bytes: Uint8Array): void {
    if (this.#disabled) return;
    this.#buffer += this.#decoder.decode(bytes, { stream: true });
    if (this.#buffer.length > 1024 * 1024) {
      this.#buffer = "";
      this.#disabled = true;
      this.#usage = undefined;
      return;
    }
    if (!this.sse) return;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) if (line.startsWith("data:")) this.#read(line.slice(5).trim());
  }
  #read(text: string): void {
    if (text === "[DONE]") {
      this.#complete = true;
      return;
    }
    try {
      const value = JSON.parse(text);
      if (value.type === "message_stop" || value.type === "response.completed")
        this.#complete = true;
      const u = value.usage ?? value.response?.usage ?? value.message?.usage;
      if (!u) return;
      const input =
        u.prompt_tokens ??
        (u.input_tokens === undefined
          ? this.#usage?.inputTokens
          : u.input_tokens +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0));
      const output = u.completion_tokens ?? u.output_tokens ?? this.#usage?.outputTokens;
      if (
        !Number.isSafeInteger(input) ||
        !Number.isSafeInteger(output) ||
        input < 0 ||
        output < 0 ||
        input > this.ceiling.inputTokens ||
        output > this.ceiling.outputTokens
      ) {
        this.#disabled = true;
        this.#usage = undefined;
        return;
      }
      // Count all input at the uncached rate: a missing cache field never undercharges.
      this.#usage = { inputTokens: input, outputTokens: output, cachedInputTokens: 0 };
    } catch {}
  }
  finish(): Usage | undefined {
    if (this.#disabled) return undefined;
    this.#buffer += this.#decoder.decode();
    if (!this.sse) this.#read(this.#buffer);
    else if (this.#buffer.startsWith("data:")) this.#read(this.#buffer.slice(5).trim());
    return !this.#disabled && (!this.sse || this.#complete) ? this.#usage : undefined;
  }
}

export interface ProxyProvider {
  baseUrl: string;
  api: "openai-chat" | "openai-responses" | "anthropic-messages";
  apiKey: string;
}

const PATHS = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  "anthropic-messages": "/messages",
} as const;

const KEYS = new Set([
  "model",
  "messages",
  "input",
  "instructions",
  "system",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "stop",
  "stop_sequences",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "parallel_tool_calls",
]);
const CONTENT_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "message",
  "function",
  "function_call",
  "function_call_output",
  "tool_use",
  "tool_result",
]);

const CONTENT_KEYS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "id",
  "type",
  "text",
  "function",
  "arguments",
  "call_id",
  "output",
  "tool_use_id",
  "is_error",
  "description",
  "parameters",
  "strict",
  "input_schema",
  "input",
]);

/** Only inline text and function tools: schemas/arguments are inert JSON, not content blocks. */
function boundedContent(value: unknown): boolean {
  if (value === undefined || value === null || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(boundedContent);
  if (typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (typeof object.type === "string" && !CONTENT_TYPES.has(object.type)) return false;
  return Object.entries(object).every(([key, child]) => {
    if (!CONTENT_KEYS.has(key)) return false;
    if (
      key === "parameters" ||
      key === "input_schema" ||
      key === "arguments" ||
      (key === "input" && object.type === "tool_use") ||
      key === "is_error" ||
      key === "strict"
    )
      return true;
    return boundedContent(child);
  });
}

/** A relative inference path is selected, never resolved against a caller-controlled URL. */
export function proxyRequest(
  provider: ProxyProvider,
  path: string,
  value: unknown,
  maxOutputTokens: number,
): { url: string; body: Record<string, unknown>; inputTokens: number } | null {
  if (path !== PATHS[provider.api]) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !KEYS.has(key))) return null;
  if (typeof source.model !== "string" || !source.model || source.model.length > 256) return null;
  if (
    ![
      source.messages,
      source.input,
      source.tools,
      source.system,
      source.instructions,
      source.tool_choice,
    ].every(boundedContent)
  )
    return null;
  if (source.stream !== undefined && typeof source.stream !== "boolean") return null;
  let base: URL;
  try {
    base = new URL(provider.baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    return null;
  const body = { ...source };
  delete body.max_tokens;
  delete body.max_completion_tokens;
  delete body.max_output_tokens;
  delete body.stream_options;
  const outputKey =
    provider.api === "anthropic-messages"
      ? "max_tokens"
      : provider.api === "openai-responses"
        ? "max_output_tokens"
        : "max_completion_tokens";
  body[outputKey] = maxOutputTokens;
  if (provider.api === "openai-chat" && body.stream) body.stream_options = { include_usage: true };
  // UTF-8 bytes upper-bound text tokens, with ample per-message/tool framing allowance.
  // Never accept files or opaque server-side context whose input this bound cannot cover.
  const json = JSON.stringify(source);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > 256 * 1024) return null;
  const frames =
    (Array.isArray(source.messages) ? source.messages.length : 0) +
    (Array.isArray(source.input) ? source.input.length : 0) +
    (Array.isArray(source.tools) ? source.tools.length : 0);
  return {
    url: base.href.replace(/\/$/, "") + path,
    body,
    inputTokens: bytes + 1024 + frames * 256,
  };
}
