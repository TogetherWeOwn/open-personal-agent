// SPDX-License-Identifier: Apache-2.0
import type { CapabilityScope } from "@opa/db/capability-tokens";
import type { LedgerCall } from "@opa/db/repository";
import { findPrice } from "@opa/pricing";
import { resolveCompat, SseParser } from "@opa/providers";
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
      let livenessTimer: ReturnType<typeof setTimeout>;
      let notifyAbort: () => void = () => {};
      const aborted = new Promise<null>((resolve) => {
        notifyAbort = () => resolve(null);
      });
      const finish = (usage?: Usage) => {
        if (finished) return finished;
        clearTimeout(timer);
        clearTimeout(livenessTimer);
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
      // System-store expiry/compromise writes bypass scoped task RPCs. Recheck even while
      // fetch/read is stalled or the client applies backpressure. Storage failure fails closed;
      // recursive timeouts prevent overlapping checks and stop with this call's settlement.
      const checkLiveness = async () => {
        try {
          if (finished) return;
          let live: CapabilityScope | null;
          // Periodic storage reads must not hold or reset the DO input gate on a stall.
          try {
            live = await this.deps.verify(token);
          } catch {
            live = null;
          }
          const shouldAbort =
            !finished &&
            (!live ||
              live.tokenId !== scope.tokenId ||
              live.taskId !== scope.taskId ||
              live.userId !== scope.userId ||
              live.expiresAt <= Date.now());
          // Settlement can also fail; contain both failures within this call.
          if (shouldAbort && !finished) await abort().catch(() => {});
        } catch {
          if (!finished) await abort().catch(() => {});
        } finally {
          if (!finished) livenessTimer = setTimeout(() => void checkLiveness(), 1_000);
        }
      };
      livenessTimer = setTimeout(() => void checkLiveness(), 1_000);
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
        redact: (text: string) =>
          provider.apiKey ? text.split(provider.apiKey).join("[redacted]") : text,
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
    const sse = type === "text/event-stream";
    const usage = new ProxyUsage(sse, admitted.call.ceiling);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const parser = new SseParser();
    let json = "";
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          admitted.setOutput(controller);
        },
        async pull(controller) {
          try {
            // No raw provider bytes escape: buffer one bounded JSON body or complete SSE
            // event, redact decoded JSON strings (including escaped credentials), then emit.
            while (true) {
              const next = await reader.read();
              if (admitted.upstream.signal.aborted) return;
              const text = next.done
                ? decoder.decode()
                : decoder.decode(next.value, { stream: true });
              let wire = "";
              if (sse) {
                for (const event of parser.push(text, next.done)) {
                  if (event.heartbeat) {
                    wire += ": heartbeat\n\n";
                    continue;
                  }
                  usage.read(event.data);
                  const data =
                    event.data === "[DONE]" || event.data === ""
                      ? event.data
                      : redactJson(event.data, admitted.redact);
                  wire += `${event.event ? `event: ${admitted.redact(event.event)}\n` : ""}data: ${data}\n\n`;
                }
              } else {
                json += text;
                if (json.length > 1024 * 1024) throw new Error("provider response too large");
                if (next.done) {
                  usage.read(json);
                  wire = redactJson(json, admitted.redact);
                }
              }
              if (wire) controller.enqueue(encoder.encode(wire));
              if (next.done) {
                await admitted.finish(usage.finish());
                controller.close();
              }
              if (next.done || wire) return;
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

/** Parse before redaction so usage is independent of diagnostic text. No response is persisted. */
function redactJson(text: string, redact: (text: string) => string): string {
  const value = JSON.parse(text);
  // Walk decoded strings and member names, not JSON escape spellings.
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [redact(key), walk(child)]),
      );
    return item;
  };
  return JSON.stringify(walk(value));
}

/** Only complete usage events are inspected; nullable cumulative fields mean unchanged. */
class ProxyUsage {
  #usage: Usage | undefined;
  #counts: Record<string, number> = {};
  #disabled = false;
  #complete = false;
  constructor(
    private readonly sse: boolean,
    private readonly ceiling: Usage,
  ) {}
  read(text: string): void {
    if (this.#disabled) return;
    if (text === "[DONE]") {
      this.#complete = true;
      return;
    }
    try {
      const value = JSON.parse(text);
      if (
        value.type === "message_stop" ||
        value.type === "response.completed" ||
        value.type === "response.incomplete"
      )
        this.#complete = true;
      const u = value.usage ?? value.response?.usage ?? value.message?.usage;
      if (!u) return;
      for (const key of [
        "prompt_tokens",
        "input_tokens",
        "completion_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ]) {
        const count = u[key];
        if (count == null) continue;
        if (!Number.isSafeInteger(count) || count < 0) {
          this.#disabled = true;
          this.#usage = undefined;
          return;
        }
        this.#counts[key] = Math.max(this.#counts[key] ?? 0, count);
      }
      const c = this.#counts;
      const input =
        c.prompt_tokens ??
        (c.input_tokens === undefined
          ? undefined
          : c.input_tokens +
            (c.cache_read_input_tokens ?? 0) +
            (c.cache_creation_input_tokens ?? 0));
      const output = c.completion_tokens ?? c.output_tokens;
      if (input === undefined || output === undefined) return;
      if (
        !Number.isSafeInteger(input) ||
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
  "store",
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
function boundedContent(value: unknown, responses = false): boolean {
  if (value === undefined || value === null || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every((child) => boundedContent(child, responses));
  if (typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  if (typeof object.type === "string" && !CONTENT_TYPES.has(object.type)) return false;
  // Responses defaults an untyped ID to an opaque stored-item reference.
  if (responses && "id" in object && typeof object.type !== "string") return false;
  return Object.entries(object).every(([key, child]) => {
    if (responses && key === "status")
      return (
        ["message", "function_call", "function_call_output"].includes(String(object.type)) &&
        ["in_progress", "completed", "incomplete"].includes(String(child))
      );
    if (responses && key === "annotations")
      return object.type === "output_text" && Array.isArray(child) && child.length === 0;
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
    return boundedContent(child, responses);
  });
}

function boundedToolChoice(value: unknown, api: ProxyProvider["api"]): boolean {
  if (value === undefined) return true;
  if (typeof value === "string")
    return api !== "anthropic-messages" && ["auto", "none", "required"].includes(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choice = value as Record<string, unknown>;
  const named = (name: unknown) =>
    typeof name === "string" && name.length > 0 && name.length <= 256;
  if (api === "anthropic-messages") {
    return (
      typeof choice.type === "string" &&
      ["auto", "any", "none", "tool"].includes(choice.type) &&
      Object.keys(choice).every((key) =>
        ["type", "name", "disable_parallel_tool_use"].includes(key),
      ) &&
      (choice.type === "tool" ? named(choice.name) : choice.name === undefined) &&
      (choice.disable_parallel_tool_use === undefined ||
        typeof choice.disable_parallel_tool_use === "boolean")
    );
  }
  if (choice.type !== "function") return false;
  if (api === "openai-responses")
    return Object.keys(choice).every((key) => ["type", "name"].includes(key)) && named(choice.name);
  const fn = choice.function;
  return (
    Object.keys(choice).every((key) => ["type", "function"].includes(key)) &&
    !!fn &&
    typeof fn === "object" &&
    !Array.isArray(fn) &&
    Object.keys(fn).every((key) => key === "name") &&
    named((fn as Record<string, unknown>).name)
  );
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
    ![source.messages, source.input, source.tools, source.system, source.instructions].every(
      (content) => boundedContent(content, provider.api === "openai-responses"),
    ) ||
    !boundedToolChoice(source.tool_choice, provider.api)
  )
    return null;
  if (source.stream !== undefined && typeof source.stream !== "boolean") return null;
  if (
    source.store !== undefined &&
    (provider.api !== "openai-responses" || typeof source.store !== "boolean")
  )
    return null;
  let base: URL;
  try {
    base = new URL(provider.baseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
    return null;
  const body = { ...source };
  let outputTokens = maxOutputTokens;
  // Normalize aliases without ever raising a caller's ceiling, even if several are supplied.
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    if (key in source) {
      const cap = source[key];
      if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap <= 0) return null;
      outputTokens = Math.min(outputTokens, cap);
    }
    delete body[key];
  }
  delete body.stream_options;
  const outputKey =
    provider.api === "anthropic-messages"
      ? "max_tokens"
      : provider.api === "openai-responses"
        ? "max_output_tokens"
        : resolveCompat(provider.baseUrl).maxTokensField;
  body[outputKey] = outputTokens;
  if (provider.api === "openai-responses") body.store = false;
  if (
    provider.api === "openai-chat" &&
    body.stream &&
    resolveCompat(provider.baseUrl).supportsUsageInStreaming
  )
    body.stream_options = { include_usage: true };
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
