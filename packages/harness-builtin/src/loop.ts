// SPDX-License-Identifier: Apache-2.0
// `builtin-loop` (M3-03b, ADR 0005 #7, M2-16 note): our own tool loop over the ModelProvider port.
// It holds no storage: everything a turn needs to resume is plain data in `TurnState`, which the
// host persists with the turn (M3-03c). Approvals are stop-and-resume: the run ends at the approval,
// and the decision resumes it on a later request, possibly in another process.
import type {
  FinishReason,
  ModelMessage,
  ModelProvider,
  ModelToolCall,
  ModelUsage,
} from "@opa/core";
import {
  addContext,
  type ContextEvent,
  decide,
  fitsApproval,
  type PolicyDecision,
  type RegisteredTool,
  type StandingGrant,
  type TaintState,
  type ToolManifest,
  type ToolOverride,
  type ToolRegistry,
  TRUSTED,
} from "@opa/policy";
import type { ApprovalDecision, ApprovalItem, LimitKind, LoopEvent, TurnOutcome } from "./events";
import { canonical, parseInput } from "./schema";

/** COST-1 per-turn limits (M3-03 AC7). They replace M2's one call a turn. */
export const TURN_LIMITS = { calls: 8, tools: 20 } as const;
/** Tool calls a user may make in any minute (COST-2); the host counts them, the loop names it. */
export const TOOL_RATE = 60;
/** How long an interactive approval waits (M3-07 AC1, ADR 0010 D9). */
export const APPROVAL_TTL_MS = 24 * 3_600_000;
/** What a gated call's result reads while it waits, so the history stays valid for every provider. */
export const WAITING_FOR_APPROVAL = "Waiting for the user's approval.";
const PREVIEW_CHARS = 200;

export type ToolOutput = {
  ok: boolean;
  content: string; // what the model reads; on failure, the error
  // What the result adds to the context, for taint. Omitted, it counts as an untrusted tool result;
  // a tool whose result is only its own text says `{ kind: "system" }`.
  context?: ContextEvent;
  // A file the call created (M3-08 AC3): the loop announces it with `artifact.created`, so the
  // transcript and Outputs learn about it from the event log, not from the tool's text.
  artifact?: { artifactId: string; name: string; type: string; bytes: number };
  // The host refused to run the tool: the user made 60 tool calls in the last minute (COST-2).
  // The loop stops with `limit.reached{tool_rate}` once the calls started with it have finished.
  slowDown?: true;
};

export interface LoopTool extends RegisteredTool {
  /** What the call reaches, e.g. a URL's host: shown on the card and matched by grants. */
  target?(input: Record<string, unknown>): string | undefined;
  /**
   * Who wrote the manifest's description. A third party's (an MCP server's or a plugin's, M5) is
   * untrusted text the model reads (R7 §5.9), so a turn that offers the tool is tainted.
   */
  author?: "first_party" | "third_party";
  /**
   * `call` names the model's call; `approved` when it runs under an approval the host claimed,
   * so a durable host can keep it to one run (crypto review W3).
   */
  execute(
    input: Record<string, unknown>,
    signal: AbortSignal,
    call?: { toolCallId: string; approved: boolean },
  ): Promise<ToolOutput>;
}

/** A gated call as the turn keeps it. `stepUp`: approving needs a passkey (M3-07 AC4). */
export type PendingItem = ApprovalItem & {
  toolCallId: string;
  stepUp: boolean;
  decision?: ApprovalDecision;
};

/** How an approved call ended, for its approval row and the audit log (M3-07 AC12). */
export type ApprovedOutcome =
  | { status: "executed" | "failed" }
  | { status: "denied" | "expired"; reason: string };

/** A turn's resumable state. Plain JSON, so the host can store it (in D1, M3-03c). */
export type TurnState = {
  messages: ModelMessage[]; // this turn's messages, after the history the host passes in
  taint: TaintState;
  counts: { calls: number; tools: number }; // persist with the turn, so a resume doesn't reset them
  usage: ModelUsage; // summed over the turn's calls, for the ledger
  pending: { batchId: string; items: PendingItem[] } | null;
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
  /**
   * A steer that arrived mid-turn (M3-09 AC4), oldest first. The loop drains it at every step
   * boundary, so a steer changes the next step without restarting the turn. The host writes
   * the text to history itself; the loop appends it to the turn's messages and announces it.
   */
  takeSteer?: () => { messageId: string; text: string } | null;
  now(): number;
  newId(): string; // step and batch ids
  /**
   * The approval rows behind a resumed batch (M3-07 AC12). `claim` runs just before an approved
   * call would start, after the policy re-check allowed it: `null` lets it run, a reason stops
   * it as denied. `finish` records how every decided call of the batch ended.
   */
  approvals?: {
    claim(toolCallId: string): Promise<string | null>;
    finish(toolCallId: string, outcome: ApprovedOutcome): Promise<void>;
  };
};

/**
 * Thrown by a host's provider before it yields anything, when a spend limit refused the call
 * (M3-17): the call never ran, so it isn't counted, and the turn stops resumably with
 * `limit.reached` instead of failing.
 */
export class LimitStop extends Error {
  constructor(
    readonly kind: LimitKind,
    readonly detail: string,
  ) {
    super(`limit reached (${kind}): ${detail}`);
    this.name = "LimitStop";
  }
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "unknown" | "duplicate" | "stale" | "scope",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

const ZERO: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

export function newTurn(taint: TaintState = TRUSTED): TurnState {
  return { messages: [], taint, counts: { calls: 0, tools: 0 }, usage: { ...ZERO }, pending: null };
}

/**
 * Records decisions on the pending batch. It checks every decision first and throws before
 * changing anything, so an unknown, stale or duplicate id never touches the history (M3-03 AC4).
 */
export function resolveApprovals(
  state: TurnState,
  batchId: string,
  decisions: readonly ApprovalDecision[],
  now: number,
): void {
  const batch = state.pending;
  if (!batch || batch.batchId !== batchId) throw new ApprovalError("unknown", "no such batch");
  const seen = new Set<string>();
  for (const d of decisions) {
    const item = batch.items.find((i) => i.approvalId === d.approvalId);
    if (!item) throw new ApprovalError("unknown", `no pending approval ${d.approvalId}`);
    if (item.decision || seen.has(d.approvalId)) {
      throw new ApprovalError("duplicate", `${d.approvalId} is already decided`);
    }
    if (now >= item.expiresAt) throw new ApprovalError("stale", `${d.approvalId} has expired`);
    if (d.decision === "approve" && !item.scopes.includes(d.scope)) {
      throw new ApprovalError("scope", `${d.approvalId} can't be approved for "${d.scope}"`);
    }
    seen.add(d.approvalId);
  }
  for (const d of decisions) {
    const item = batch.items.find((i) => i.approvalId === d.approvalId) as PendingItem;
    item.decision = { approvalId: d.approvalId, decision: d.decision, scope: d.scope };
  }
}

/** The user's Continue after `limit.reached{calls|tools}`: a fresh allowance for the same turn. */
export function continueTurn(state: TurnState): void {
  state.counts = { calls: 0, tools: 0 };
}

/** A call whose input is valid, waiting for its policy decision. */
type Run = {
  call: ModelToolCall;
  tool: LoopTool;
  manifest: ToolManifest;
  input: Record<string, unknown>;
};

type Asked = Run & { d: Extract<PolicyDecision, { outcome: "ask" }> };

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
  let slowed = false; // a tool call was refused by the per-minute tool limit

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

  /** Adds what joined the context to the turn's taint, announcing the first untrusted source. */
  function* addTaint(event: ContextEvent): Generator<LoopEvent> {
    const was = state.taint.taint;
    state.taint = addContext(state.taint, event);
    const source = state.taint.sources[0];
    if (was === "trusted" && state.taint.taint === "untrusted" && source) {
      // `context.tainted` names web, file or tool; an untrusted memory arrives through a tool.
      const kind = source.kind === "memory" ? "tool" : source.kind;
      yield ev("context.tainted", { stepId, source: { kind, label: source.label } });
    }
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

  /** Claims an approved call's row; a reason when it can't run. A host failure refuses it. */
  async function claimed(toolCallId: string): Promise<string | null> {
    if (!host.approvals) return null;
    try {
      return await host.approvals.claim(toolCallId);
    } catch {
      return "The approval couldn't be checked, so the call didn't run.";
    }
  }

  /**
   * Records how a decided call ended; the resume awaits them all before its next model call. A
   * failure leaves the row as it was (an `executing` row is never run again).
   */
  const finishing: Promise<void>[] = [];
  const finish = (toolCallId: string, outcome: ApprovedOutcome) => {
    if (host.approvals) finishing.push(host.approvals.finish(toolCallId, outcome).catch(() => {}));
  };

  /**
   * Decides and runs calls in the model's order. Each call is decided against the taint when it
   * starts, so a write after an untrusted read is decided as tainted. Consecutive reads start
   * together; any other call starts after everything before it has finished. Returns the calls
   * that ask; with `approved`, the user already said yes, so an `ask` runs.
   */
  async function* execute(runs: Run[], approved = false): AsyncGenerator<LoopEvent, Asked[]> {
    const asks: Asked[] = [];
    for (let i = 0; i < runs.length && !signal.aborted; ) {
      let end = i + 1;
      const isRead = (r: Run | undefined) => r?.manifest.riskClass === "read";
      while (isRead(runs[i]) && isRead(runs[end])) end++;
      const group = [];
      for (const run of runs.slice(i, end)) {
        const d = decision(run.tool, run.manifest, run.input);
        // An approved call is checked again against the policy as it is now (M3-07 AC12): the
        // override may be `never` by now. Then the host claims its approval row; a call whose
        // row it can't claim (decided twice, expired, rebound) doesn't run either.
        const refused =
          !d || d.outcome === "deny"
            ? deniedText(d, approved)
            : approved
              ? await claimed(run.call.id)
              : null;
        if (refused !== null) {
          if (approved && (!d || d.outcome === "deny")) {
            finish(run.call.id, { status: "denied", reason: d?.rule ?? "policy_unreadable" });
          }
          yield* skip(run.call, refused, "denied");
        } else if (d?.outcome === "ask" && !approved) {
          // An approval binds the arguments exactly; past its limit there is nothing to ask.
          if (fitsApproval(run.input, run.tool.target?.(run.input) ?? null))
            asks.push({ ...run, d });
          else yield* skip(run.call, TOO_LARGE_TO_APPROVE, "error");
        } else {
          const id = host.newId();
          const began = host.now();
          // Through an async function, so a tool that throws before its promise yields an error.
          const out = (async () =>
            run.tool.execute(run.input, signal, { toolCallId: run.call.id, approved }))()
            .catch(failed)
            .then((o) => ({ ...o, ended: host.now() }));
          group.push({ run, id, began, out });
          yield ev("step.started", { stepId: id, label: run.call.name, toolCallId: run.call.id });
        }
      }
      for (const { run, id, began, out } of group) {
        const o = await out;
        if (approved) finish(run.call.id, { status: o.ok ? "executed" : "failed" });
        if (o.slowDown) slowed = true;
        stepId = id;
        yield* result(run.call, o.ok, o.content);
        if (o.ok && o.artifact) yield ev("artifact.created", o.artifact);
        yield* addTaint(o.context ?? { kind: "tool", label: run.call.name });
        const status = o.ok ? "ok" : "error";
        yield ev("step.completed", { stepId: id, status, durationMs: o.ended - began });
      }
      i = end;
    }
    return asks;
  }

  /** Closes every call of the last assistant message that has no result, or only a placeholder. */
  function* closeOpen(content: string): Generator<LoopEvent> {
    const last = messages.findLast((m) => m.role === "assistant");
    for (const call of (last?.role === "assistant" && last.toolCalls) || []) {
      const done = messages.find((m) => m.role === "tool" && m.toolCallId === call.id);
      if (!done || done.content === WAITING_FOR_APPROVAL) yield* result(call, false, content);
    }
  }

  function* cancelled(): Generator<LoopEvent, TurnOutcome> {
    yield* closeOpen("Cancelled by the user.");
    state.pending = null;
    yield ev("turn.cancelled", {});
    return "cancelled";
  }

  function* limit(kind: LimitKind, detail: string): Generator<LoopEvent, TurnOutcome> {
    yield ev("limit.reached", { kind, detail });
    return "limit_reached";
  }

  if (signal.aborted) return yield* cancelled();
  // Resume once every call in the batch is decided. An approval that expired undecided counts as
  // denied. An approved call is checked again against the tool's current schema and policy.
  if (state.pending) {
    const { batchId, items } = state.pending;
    const now = host.now();
    if (items.some((i) => !i.decision && now < i.expiresAt)) return "awaiting_approval";
    const decisions = items.map(
      (i): ApprovalDecision =>
        i.decision ?? { approvalId: i.approvalId, decision: "deny", scope: "once" },
    );
    yield ev("approval.resolved", { batchId, decisions });
    const runs: Run[] = [];
    for (const item of items) {
      const call = { id: item.toolCallId, name: item.tool, arguments: item.args };
      const entry = host.tools.get(item.tool);
      const parsed = entry && parseInput(entry.manifest.inputSchema, item.args);
      if (!item.decision) {
        finish(call.id, { status: "expired", reason: "expired" });
        yield* skip(call, "The approval expired, so the call didn't run.", "denied");
      } else if (item.decision.decision === "deny") {
        yield* skip(call, "The user denied this call.", "denied");
      } else if (!entry || !parsed) {
        finish(call.id, { status: "denied", reason: "tool_missing" });
        yield* skip(call, `There is no tool named "${item.tool}".`, "error");
      } else if (!parsed.ok) {
        finish(call.id, { status: "denied", reason: "invalid_input" });
        yield* skip(call, parsed.error, "error");
      } else {
        runs.push({ call, tool: entry.tool, manifest: entry.manifest, input: parsed.input });
      }
    }
    state.pending = null;
    yield* execute(runs, true);
    await Promise.all(finishing);
    if (slowed) return yield* limit("tool_rate", `${TOOL_RATE} tool calls a minute`);
  }

  for (;;) {
    if (signal.aborted) return yield* cancelled();
    // Steers join the turn's messages here, so the next model call reads them (M3-09 AC4). Each
    // is announced where it lands: a steer that arrives while a limit stops the turn is still
    // recorded, and the host persists it with the stopped state.
    for (let steer = host.takeSteer?.(); steer; steer = host.takeSteer?.()) {
      messages.push({ role: "user", content: steer.text });
      yield ev("turn.steered", { messageId: steer.messageId, text: steer.text });
    }
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
    // A third party's description is in the context from this call on, so it taints the turn
    // before anything the call asks for is decided.
    for (const { name } of tools) {
      const label = `${name} description`;
      if (host.tools.get(name)?.tool.author !== "third_party") continue;
      if (state.taint.sources.some((s) => s.kind === "tool" && s.label === label)) continue;
      yield* addTaint({ kind: "tool", label });
    }
    let text = "";
    const calls: ModelToolCall[] = [];
    let usage: ModelUsage | null = null;
    let failure: string | undefined;
    let finish: FinishReason | undefined;
    let stop: LimitStop | undefined;
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
        else if (event.type === "done") finish = event.finishReason;
        else if (event.type === "error") failure = event.message;
      }
    } catch (e) {
      if (e instanceof LimitStop) stop = e;
      else failure = e instanceof Error ? e.message : "The model call failed.";
    } finally {
      if (budget) host.budget?.settle(usage);
    }
    if (stop) {
      state.counts.calls -= 1; // refused before it ran
      yield ev("step.completed", { stepId, status: "error", durationMs: host.now() - began });
      return yield* limit(stop.kind, stop.detail);
    }
    if (usage) {
      for (const k of Object.keys(ZERO) as (keyof ModelUsage)[]) state.usage[k] += usage[k] ?? 0;
      yield ev("usage.updated", { usage, providerId: host.provider.id, model: host.model });
    }
    const ids = new Set(
      messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : [])).map((c) => c.id),
    );
    const repeated = calls.some((c) => ids.has(c.id) || !ids.add(c.id));
    if (!signal.aborted && !failure && repeated) failure = "The model repeated a tool call id.";
    // A reply cut short with no calls is not an answer; the partial text is kept.
    if (!failure && calls.length === 0 && finish !== undefined && finish in CUT_SHORT) {
      failure = CUT_SHORT[finish as keyof typeof CUT_SHORT];
    }

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

    // Validate every call before policy sees it (M3-03 AC2).
    const runs: Run[] = [];
    for (const call of calls) {
      const entry = host.tools.get(call.name);
      const parsed = entry && parseInput(entry.manifest.inputSchema, call.arguments);
      const args = parsed?.ok ? canonical(parsed.input) : call.arguments;
      const risk = entry?.manifest.riskClass ?? "irreversible";
      yield ev("tool.called", { toolCallId: call.id, tool: call.name, args, risk });
      if (!entry || !parsed) {
        yield* skip(call, `There is no tool named "${call.name}".`, "error");
      } else if (!parsed.ok) {
        yield* skip(call, parsed.error, "error");
      } else {
        runs.push({ call, tool: entry.tool, manifest: entry.manifest, input: parsed.input });
      }
    }
    const asks = yield* execute(runs);
    if (signal.aborted) return yield* cancelled();
    if (slowed) {
      yield* closeOpen("Not run: too many tool calls in the last minute.");
      return yield* limit("tool_rate", `${TOOL_RATE} tool calls a minute`);
    }
    if (asks.length > 0) {
      // One batch for the step; each gated call gets a placeholder result while it waits.
      const source = state.taint.sources[0];
      const items = asks.map(({ call, tool, input, d }): PendingItem => {
        const target = tool.target?.(input);
        messages.push({ role: "tool", toolCallId: call.id, content: WAITING_FOR_APPROVAL });
        return {
          approvalId: `appr_${call.id}`,
          toolCallId: call.id,
          tool: call.name,
          args: canonical(input),
          ...(target === undefined ? {} : { target }),
          risk: d.risk,
          rule: d.rule,
          ...(d.taint === "untrusted" && source ? { taint: source } : {}),
          scopes: d.scopes,
          expiresAt: host.now() + APPROVAL_TTL_MS,
          stepUp: d.stepUp,
        };
      });
      const batchId = `batch_${host.newId()}`;
      state.pending = { batchId, items };
      const card = items.map(({ toolCallId: _, decision: __, stepUp: ___, ...item }) => item);
      yield ev("approval.requested", { batchId, items: card });
      return "awaiting_approval";
    }
  }
}

const TOO_LARGE_TO_APPROVE =
  "The arguments are too large to ask the user to approve, so the call didn't run.";

const CUT_SHORT = {
  length: "The reply was cut off at the output limit.",
  content_filter: "The provider's content filter stopped the reply.",
};

function deniedText(d: PolicyDecision | null, approved: boolean): string {
  if (!d) return "The policy couldn't be read, so the call didn't run.";
  if (approved) return "Policy no longer allows this call.";
  return d.rule === "override_never"
    ? "The user has turned this tool off."
    : "Policy doesn't allow this call.";
}
