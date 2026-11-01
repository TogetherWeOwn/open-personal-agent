// SPDX-License-Identifier: Apache-2.0
// A scripted model and a host for the loop tests.
import type { ModelEvent, ModelMessage, ModelProvider, ModelRequest } from "@opa/core";
import { type RiskClass, ToolRegistry } from "@opa/policy";
import {
  type LoopEvent,
  type LoopHost,
  type LoopTool,
  runTurn,
  type ToolOutput,
  type TurnOutcome,
  type TurnState,
} from "../src/index";

export const NOW = Date.UTC(2026, 10, 1);

type Reply = { text?: string; calls?: [name: string, args: unknown][]; delayMs?: number };

/** A model that answers each call with the next reply, or one computed from the request. */
export function scripted(replies: (Reply | ((req: ModelRequest) => Reply))[]) {
  const requests: ModelRequest[] = [];
  let ids = 0;
  const provider: ModelProvider = {
    id: "mock",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(req): AsyncIterable<ModelEvent> {
      const { signal: _, ...copy } = req;
      requests.push(structuredClone(copy));
      const next = replies[requests.length - 1] ?? { text: "done" };
      const reply = typeof next === "function" ? next(req) : next;
      for (const word of (reply.text ?? "").split(/(?<= )/).filter(Boolean)) {
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (req.signal?.aborted) {
          yield { type: "error", code: "aborted", message: "aborted" };
          return;
        }
        yield { type: "text.delta", text: word };
      }
      for (const [name, args] of reply.calls ?? []) {
        const toolCall = { id: `call_${++ids}`, name, arguments: JSON.stringify(args) };
        yield { type: "tool_call", toolCall };
      }
      const usage = { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 0 };
      yield { type: "usage", usage };
      yield { type: "done", finishReason: reply.calls ? "tool_calls" : "stop" };
    },
  };
  return { provider, requests };
}

export type Spy = LoopTool & { inputs: Record<string, unknown>[] };
type Run = (
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ToolOutput> | ToolOutput;
const done =
  (name: string): Run =>
  () => ({ ok: true, content: `${name} ok`, context: { kind: "system" } });

/** A tool of the given risk class. Its result is untrusted unless `context` says otherwise. */
export function tool(
  name: string,
  riskClass: RiskClass,
  run: Run = done(name),
  egress = false,
): Spy {
  const inputs: Record<string, unknown>[] = [];
  return {
    manifest: {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
        type: "object",
        properties: { q: { type: "string", minLength: 1 } },
        required: ["q"],
        additionalProperties: false,
      },
      riskClass,
      destinations: egress ? [{ id: "web", kind: "third_party", dataEgress: true }] : [],
      scopes: [],
    },
    target: (input) => (egress ? String(input.q) : undefined),
    inputs,
    async execute(input, signal) {
      inputs.push(input);
      return run(input, signal);
    },
  };
}

export function host(provider: ModelProvider, tools: LoopTool[], over: Partial<LoopHost> = {}) {
  const registry = new ToolRegistry<LoopTool>();
  for (const t of tools) registry.register(t);
  let id = 0;
  return {
    provider,
    model: "m",
    tools: registry,
    policy: () => ({}),
    now: () => NOW,
    newId: () => `s${++id}`,
    ...over,
  } satisfies LoopHost;
}

export const history: ModelMessage[] = [{ role: "user", content: "hello" }];

/** Runs the loop to its end and collects what it emitted. */
export async function drain(
  h: LoopHost,
  state: TurnState,
  signal = new AbortController().signal,
): Promise<{ events: LoopEvent[]; outcome: TurnOutcome }> {
  const events: LoopEvent[] = [];
  const run = runTurn(h, history, state, signal);
  for (;;) {
    const next = await run.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

export const types = (events: LoopEvent[]) => events.map((e) => e.type);
export const ofType = <T extends LoopEvent["type"]>(events: LoopEvent[], type: T) =>
  events.filter((e): e is Extract<LoopEvent, { type: T }> => e.type === type);
