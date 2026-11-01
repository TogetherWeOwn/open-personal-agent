// SPDX-License-Identifier: Apache-2.0
// `builtin-loop` (M3-03b, ADR 0005 #7, M2-16 note): our own tool loop over the ModelProvider port.
// It holds no storage: everything a turn needs to resume is plain data in `TurnState`, which the
// host persists with the turn (M3-03c), so a turn can stop and go on in another process.
import type { ModelMessage, ModelProvider, ModelToolCall, ModelUsage } from "@opa/core";
import {
  addContext,
  type ContextEvent,
  decide,
  type RegisteredTool,
  type RiskClass,
  type StandingGrant,
  type TaintState,
  type ToolManifest,
  type ToolOverride,
  type ToolRegistry,
  TRUSTED,
} from "@opa/policy";
import type { LimitKind, LoopEvent, TurnOutcome } from "./events";
import { canonical, parseInput } from "./schema";

/** COST-1 per-turn limits (M3-03 AC7). They replace M2's one call a turn. */
export const TURN_LIMITS = { calls: 8, tools: 20 } as const;
const PREVIEW_CHARS = 200;

export type ToolOutput = {
  ok: boolean;
  content: string; // what the model reads; on failure, the error
  // What the result adds to the context, for taint. Omitted, it counts as an untrusted tool result;
  // a tool whose result is only its own text says `{ kind: "system" }`.
  context?: ContextEvent;
};

export interface LoopTool extends RegisteredTool {
  /** What the call reaches, e.g. a URL's host: shown on the card and matched by grants. */
  target?(input: Record<string, unknown>): string | undefined;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutput>;
}

/** A turn's resumable state. Plain JSON, so the host can store it (in D1, M3-03c). */
export type TurnState = {
  messages: ModelMessage[]; // this turn's messages, after the history the host passes in
  taint: TaintState;
  counts: { calls: number; tools: number }; // persist with the turn, so a resume doesn't reset them
  usage: ModelUsage; // summed over the turn's calls, for the ledger
};

export type Budget = {
  /** Before each model call: the output cap it may use, or the limit that stops it. */
  reserve(
    messages: readonly ModelMessage[],
  ): { maxOutputTokens: number } | { limit: LimitKind; detail: string };
  /** After each call that reserved, with what it used (`null` if the upstream reported none). */
  settle(usage: ModelUsage | null): void;
};

export type LoopHost = {
  provider: ModelProvider;
  model: string;
  tools: ToolRegistry<LoopTool>; // what this turn may offer the model
  /** The user's override and grants for a tool, read fresh for each decision. */
  policy(tool: string): { override?: ToolOverride; grants?: readonly StandingGrant[] };
  budget?: Budget;
  taskId?: string;
  now(): number;
  newId(): string; // step and batch ids
};

const ZERO: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

export function newTurn(taint: TaintState = TRUSTED): TurnState {
  return { messages: [], taint, counts: { calls: 0, tools: 0 }, usage: { ...ZERO } };
}

/** The user's Continue after `limit.reached{calls|tools}`: a fresh allowance for the same turn. */
export function continueTurn(state: TurnState): void {
  state.counts = { calls: 0, tools: 0 };
}

/** A checked call that may run now. */
type Run = { call: ModelToolCall; tool: LoopTool; risk: RiskClass; input: Record<string, unknown> };

const ev = <T extends LoopEvent["type"]>(
  type: T,
  payload: Extract<LoopEvent, { type: T }>["payload"],
): LoopEvent => ({ type, payload }) as LoopEvent;

const failed = (e: unknown): ToolOutput => ({
  ok: false,
  content: e instanceof Error ? e.message : "The tool failed.",
});

/**
 * Runs the turn until it completes, stops at an approval or a limit, is cancelled or fails. It
 * mutates `state` as it goes; the host persists it when the run returns. `history` is the context
 * before this turn, the user's message last. One `signal` per turn reaches the provider stream and
 * every tool (M3-03 AC6).
 */
export async function* runTurn(
  host: LoopHost,
  history: readonly ModelMessage[],
  state: TurnState,
  signal: AbortSignal,
): AsyncGenerator<LoopEvent, TurnOutcome> {
  const { messages } = state;
  let stepId = "";

  /** Records a call's result, replacing its placeholder if it has one. */
  function* result(call: ModelToolCall, ok: boolean, content: string): Generator<LoopEvent> {
    const at = messages.findIndex((m) => m.role === "tool" && m.toolCallId === call.id);
    messages.splice(at < 0 ? messages.length : at, at < 0 ? 0 : 1, {
      role: "tool",
      toolCallId: call.id,
      content,
    });
    const preview = content.slice(0, PREVIEW_CHARS);
    const bytes = new TextEncoder().encode(content).length;
    yield ev("tool.result", {
      toolCallId: call.id,
      ok,
      preview,
      bytes,
      ...(ok ? {} : { error: preview }),
    });
  }

  /** A call that doesn't run: its step opens and closes with the reason as its result. */
  function* skip(
    call: ModelToolCall,
    content: string,
    status: "error" | "denied",
  ): Generator<LoopEvent> {
    stepId = host.newId();
    yield ev("step.started", { stepId, label: call.name, toolCallId: call.id });
    yield* result(call, false, content);
    yield ev("step.completed", { stepId, status, durationMs: 0 });
  }

  /** The policy decision, or `null` if the host couldn't read the policy (fail closed). */
  function decision(tool: LoopTool, manifest: ToolManifest, input: Record<string, unknown>) {
    try {
      const target = tool.target?.(input);
      return decide({
        manifest,
        taint: state.taint.taint,
        ...host.policy(manifest.name),
        ...(host.taskId === undefined ? {} : { taskId: host.taskId }),
        ...(target === undefined ? {} : { target }),
        now: host.now(),
      });
    } catch {
      return null;
    }
  }

  /** Runs the calls policy allows: reads in parallel, then the rest one at a time, in order. */
  async function* execute(runs: Run[]): AsyncGenerator<LoopEvent> {
    const begin = (run: Run) => {
      const step = { run, id: host.newId(), began: host.now() };
      // Through an async function, so a tool that throws before its promise still yields an error.
      const out = (async () => run.tool.execute(run.input, signal))().catch(failed);
      return { ...step, out };
    };
    const started = (s: ReturnType<typeof begin>) =>
      ev("step.started", { stepId: s.id, label: s.run.call.name, toolCallId: s.run.call.id });
    async function* finish(s: ReturnType<typeof begin>): AsyncGenerator<LoopEvent> {
      const out = await s.out;
      stepId = s.id;
      yield* result(s.run.call, out.ok, out.content);
      const was = state.taint.taint;
      state.taint = addContext(
        state.taint,
        out.context ?? { kind: "tool", label: s.run.call.name },
      );
      const source = state.taint.sources[0];
      if (was === "trusted" && state.taint.taint === "untrusted" && source) {
        // `context.tainted` names web, file or tool; an untrusted memory arrives through a tool.
        const kind = source.kind === "memory" ? "tool" : source.kind;
        yield ev("context.tainted", { stepId, source: { kind, label: source.label } });
      }
      const status = out.ok ? "ok" : "error";
      yield ev("step.completed", { stepId: s.id, status, durationMs: host.now() - s.began });
    }
    const reads = runs.filter((r) => r.risk === "read").map(begin);
    for (const s of reads) yield started(s);
    for (const s of reads) yield* finish(s);
    for (const run of runs.filter((r) => r.risk !== "read")) {
      if (signal.aborted) return;
      const s = begin(run);
      yield started(s);
      yield* finish(s);
    }
  }

  /** Closes every call of the last assistant message that has no result, or only a placeholder. */
  function* closeOpen(content: string): Generator<LoopEvent> {
    const last = messages.findLast((m) => m.role === "assistant");
    for (const call of (last?.role === "assistant" && last.toolCalls) || []) {
      const done = messages.find((m) => m.role === "tool" && m.toolCallId === call.id);
      if (!done) yield* result(call, false, content);
    }
  }

  function* cancelled(): Generator<LoopEvent, TurnOutcome> {
    yield* closeOpen("Cancelled by the user.");
    yield ev("turn.cancelled", {});
    return "cancelled";
  }

  function* limit(kind: LimitKind, detail: string): Generator<LoopEvent, TurnOutcome> {
    yield ev("limit.reached", { kind, detail });
    return "limit_reached";
  }

  for (;;) {
    if (signal.aborted) return yield* cancelled();
    if (state.counts.calls >= TURN_LIMITS.calls) {
      return yield* limit("calls", `${TURN_LIMITS.calls} model calls`);
    }
    const context = [...history, ...messages];
    const budget = host.budget?.reserve(context);
    if (budget && "limit" in budget) return yield* limit(budget.limit, budget.detail);
    state.counts.calls += 1;
    stepId = host.newId();
    const began = host.now();
    yield ev("step.started", { stepId, label: "Thinking" });

    const tools = host.tools
      .manifests()
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    let text = "";
    const calls: ModelToolCall[] = [];
    let usage: ModelUsage | null = null;
    let failure: string | undefined;
    try {
      for await (const event of host.provider.stream({
        model: host.model,
        messages: context,
        ...(tools.length > 0 ? { tools } : {}),
        ...(budget ? { maxOutputTokens: budget.maxOutputTokens } : {}),
        signal,
      })) {
        if (event.type === "text.delta") {
          text += event.text;
          yield ev("message.delta", { text: event.text });
        } else if (event.type === "tool_call") calls.push(event.toolCall);
        else if (event.type === "usage") usage = event.usage;
        else if (event.type === "error") failure = event.message;
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : "The model call failed.";
    } finally {
      if (budget) host.budget?.settle(usage);
    }
    if (usage) {
      for (const k of Object.keys(ZERO) as (keyof ModelUsage)[]) state.usage[k] += usage[k];
      yield ev("usage.updated", { usage, providerId: host.provider.id, model: host.model });
    }
    const ids = new Set(
      messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : [])).map((c) => c.id),
    );
    const repeated = calls.some((c) => ids.has(c.id) || !ids.add(c.id));
    if (!signal.aborted && !failure && repeated) failure = "The model repeated a tool call id.";

    // A cancel or failure keeps the partial text and drops the calls, which never ran.
    const ok = !signal.aborted && failure === undefined;
    if (ok || text) {
      messages.push({
        role: "assistant",
        content: text,
        ...(ok && calls.length > 0 ? { toolCalls: calls } : {}),
      });
    }
    if (text) yield ev("message.completed", { text });
    yield ev("step.completed", {
      stepId,
      status: ok ? "ok" : "error",
      durationMs: host.now() - began,
    });
    if (signal.aborted) return yield* cancelled();
    if (failure !== undefined) {
      yield ev("turn.failed", { message: failure });
      return "failed";
    }
    if (calls.length === 0) {
      yield ev("turn.completed", {});
      return "completed";
    }
    if (state.counts.tools + calls.length > TURN_LIMITS.tools) {
      yield* closeOpen("Not run: the turn reached its tool call limit.");
      return yield* limit("tools", `${TURN_LIMITS.tools} tool calls`);
    }
    state.counts.tools += calls.length;

    // Validate, then decide, every call against the taint the step started with (M3-03 AC2–3).
    const runs: Run[] = [];
    for (const call of calls) {
      const entry = host.tools.get(call.name);
      const parsed = entry && parseInput(entry.manifest.inputSchema, call.arguments);
      const args = parsed?.ok ? canonical(parsed.input) : call.arguments;
      const risk = entry?.manifest.riskClass ?? "irreversible";
      yield ev("tool.called", { toolCallId: call.id, tool: call.name, args, risk });
      if (!entry || !parsed) {
        yield* skip(call, `There is no tool named "${call.name}".`, "error");
        continue;
      }
      if (!parsed.ok) {
        yield* skip(call, parsed.error, "error");
        continue;
      }
      const d = decision(entry.tool, entry.manifest, parsed.input);
      if (!d || d.outcome === "deny") {
        const why = !d
          ? "The policy couldn't be read"
          : d.rule === "override_never"
            ? "The user has turned this tool off"
            : "Policy doesn't allow this call";
        yield* skip(call, `${why}, so it didn't run.`, "denied");
      } else if (d.outcome !== "ask") {
        runs.push({ call, tool: entry.tool, risk, input: parsed.input });
      } else {
        // Approvals are wired in M3-03b (3/3); until then a call that asks doesn't run.
        yield* skip(call, "This call needs the user's approval, so it didn't run.", "denied");
      }
    }
    yield* execute(runs);
    if (signal.aborted) return yield* cancelled();
  }
}
