// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  ApprovalError,
  continueTurn,
  LimitStop,
  newTurn,
  resolveApprovals,
  type ToolOutput,
  TURN_LIMITS,
  WAITING_FOR_APPROVAL,
} from "../src/index";
import { drain, history, host, NOW, ofType, scripted, tool, types } from "./helpers";

describe("tool input (M3-03 AC2)", () => {
  it("returns a bad input to the model as a tool error, before policy and without running it", async () => {
    const { provider, requests } = scripted([
      {
        calls: [
          ["send", { q: "" }],
          ["send", "not an object"],
          ["nope", {}],
        ],
      },
      { text: "Sorry." },
    ]);
    const send = tool("send", "consequential");
    const policy = vi.fn(() => ({}));
    const state = newTurn();
    const { events, outcome } = await drain(host(provider, [send], { policy }), state);

    expect(outcome).toBe("completed");
    expect(send.inputs).toEqual([]);
    expect(policy).not.toHaveBeenCalled();
    expect(ofType(events, "approval.requested")).toEqual([]);
    const results = ofType(events, "tool.result").map((e) => e.payload);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0]?.error).toContain("input.q: must be at least 1 characters");
    expect(results[1]?.error).toContain("expected object, got string");
    expect(results[2]?.error).toContain('no tool named "nope"');
    // The model reads the errors on its next call.
    expect(requests[1]?.messages.filter((m) => m.role === "tool")).toHaveLength(3);
  });
});

describe("artifact.created (M3-08 AC3)", () => {
  it("announces a file a tool created, and only for a call that ran", async () => {
    const artifact = { artifactId: "a1", name: "notes.md", type: "text/markdown", bytes: 12 };
    const make = tool(
      "make",
      "write_reversible",
      (): ToolOutput => ({
        ok: true,
        content: "made",
        context: { kind: "system" },
        artifact,
      }),
    );
    const { provider } = scripted([{ calls: [["make", { q: "x" }]] }, { text: "done" }]);
    const { events } = await drain(host(provider, [make]), newTurn());
    expect(ofType(events, "artifact.created").map((e) => e.payload)).toEqual([artifact]);
    // The event follows the tool's result, inside the same step.
    const order = types(events);
    expect(order.indexOf("artifact.created")).toBeGreaterThan(order.indexOf("tool.result"));
    expect(order.indexOf("artifact.created")).toBeLessThan(order.lastIndexOf("step.completed"));

    // A failed call created nothing, whatever its output claims.
    const fail = tool(
      "make",
      "write_reversible",
      (): ToolOutput => ({
        ok: false,
        content: "no",
        artifact,
      }),
    );
    const second = scripted([{ calls: [["make", { q: "x" }]] }, { text: "done" }]);
    const failed = await drain(host(second.provider, [fail]), newTurn());
    expect(ofType(failed.events, "artifact.created")).toEqual([]);
  });
});

describe("several calls in one step (M3-03 AC3)", () => {
  it("runs ungated reads in parallel and gates the rest as one batch", async () => {
    let running = 0;
    let peak = 0;
    const slow = async () => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { ok: true, content: "page", context: { kind: "system" } } as const;
    };
    const { provider } = scripted([
      {
        calls: [
          ["read_a", { q: "1" }],
          ["read_b", { q: "2" }],
          ["send", { q: "3" }],
          ["pay", { q: "4" }],
        ],
      },
    ]);
    const tools = [
      tool("read_a", "read", slow),
      tool("read_b", "read", slow),
      tool("send", "consequential"),
      tool("pay", "irreversible"),
    ];
    const state = newTurn();
    const { events, outcome } = await drain(host(provider, tools), state);

    expect(outcome).toBe("awaiting_approval");
    expect(peak).toBe(2);
    const [batch, ...more] = ofType(events, "approval.requested");
    expect(more).toEqual([]);
    expect(batch?.payload.items.map((i) => [i.approvalId, i.tool, i.risk, i.scopes])).toEqual([
      ["appr_call_3", "send", "consequential", ["once", "hour"]],
      ["appr_call_4", "pay", "irreversible", ["once"]],
    ]);
    expect(batch?.payload.items[0]).toMatchObject({
      args: '{"q":"3"}',
      rule: "default_consequential",
    });
    expect(batch?.payload.items[0]?.expiresAt).toBe(NOW + 24 * 3_600_000);
    expect(state.pending?.batchId).toBe(batch?.payload.batchId);
    // Every call has a result, so the stored history stays valid for every provider.
    expect(state.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "page",
      "page",
      WAITING_FOR_APPROVAL,
      WAITING_FOR_APPROVAL,
    ]);
  });
});

describe("stop-and-resume approvals (M3-03 AC4)", () => {
  async function stop() {
    const send = tool("send", "consequential");
    const { provider, requests } = scripted([
      {
        text: "Sending. ",
        calls: [
          ["send", { q: "a" }],
          ["send", { q: "b" }],
        ],
      },
      { text: "Sent." },
    ]);
    const h = host(provider, [send]);
    const live = newTurn();
    await drain(h, live);
    return { send, h, requests, state: structuredClone(live) };
  }
  it("rejects an unknown, stale, duplicate or out-of-scope id before touching the state", async () => {
    const { state } = await stop();
    const batchId = state.pending?.batchId as string;
    const before = structuredClone(state);
    const ok = { approvalId: "appr_call_1", decision: "approve", scope: "once" } as const;
    const tries: [string, () => void][] = [
      ["unknown", () => resolveApprovals(state, "batch_other", [ok], NOW)],
      ["unknown", () => resolveApprovals(state, batchId, [{ ...ok, approvalId: "appr_x" }], NOW)],
      // A known id after an unknown one: nothing is recorded.
      [
        "unknown",
        () => resolveApprovals(state, batchId, [ok, { ...ok, approvalId: "call_2" }], NOW),
      ],
      ["duplicate", () => resolveApprovals(state, batchId, [ok, ok], NOW)],
      ["stale", () => resolveApprovals(state, batchId, [ok], NOW + 24 * 3_600_000)],
      ["scope", () => resolveApprovals(state, batchId, [{ ...ok, scope: "destination" }], NOW)],
    ];
    for (const [code, attempt] of tries) {
      expect(attempt).toThrow(ApprovalError);
      try {
        attempt();
      } catch (e) {
        expect((e as ApprovalError).code).toBe(code);
      }
      expect(state).toEqual(before);
    }
    resolveApprovals(state, batchId, [ok], NOW);
    expect(() => resolveApprovals(state, batchId, [ok], NOW)).toThrow("already decided");
  });

  it("waits for the whole batch, then runs the approved call and the model goes on", async () => {
    const { send, h, requests, state } = await stop();
    const batchId = state.pending?.batchId as string;
    resolveApprovals(
      state,
      batchId,
      [{ approvalId: "appr_call_1", decision: "approve", scope: "once" }],
      NOW,
    );
    expect((await drain(h, state)).outcome).toBe("awaiting_approval");
    expect(send.inputs).toEqual([]);

    resolveApprovals(
      state,
      batchId,
      [{ approvalId: "appr_call_2", decision: "deny", scope: "once" }],
      NOW,
    );
    const { events, outcome } = await drain(h, state);
    expect(outcome).toBe("completed");
    expect(send.inputs).toEqual([{ q: "a" }]);
    expect(
      ofType(events, "approval.resolved")[0]?.payload.decisions.map((d) => d.decision),
    ).toEqual(["approve", "deny"]);
    expect(ofType(events, "step.completed").map((e) => e.payload.status)).toEqual([
      "denied",
      "ok",
      "ok",
    ]);
    expect(state.pending).toBeNull();
    // The placeholders were replaced in place; no call has two results.
    expect(requests[1]?.messages.slice(1).map((m) => [m.role, m.content])).toEqual([
      ["assistant", "Sending. "],
      ["tool", "send ok"],
      ["tool", "The user denied this call."],
    ]);
    expect(state.messages.at(-1)).toEqual({ role: "assistant", content: "Sent." });
  });

  it("closes a batch whose undecided approvals expired as denied, and the model goes on", async () => {
    const { send, h, state } = await stop();
    const batchId = state.pending?.batchId as string;
    const approve = { approvalId: "appr_call_1", decision: "approve", scope: "once" } as const;
    resolveApprovals(state, batchId, [approve], NOW);
    const later = NOW + 24 * 3_600_000;
    expect(() =>
      resolveApprovals(state, batchId, [{ ...approve, approvalId: "appr_call_2" }], later),
    ).toThrow("expired");
    const { events, outcome } = await drain({ ...h, now: () => later }, state);
    expect(outcome).toBe("completed");
    expect(send.inputs).toEqual([{ q: "a" }]);
    expect(ofType(events, "approval.resolved")[0]?.payload.decisions[1]?.decision).toBe("deny");
    expect(ofType(events, "tool.result").map((e) => e.payload.preview)).toEqual([
      "The approval expired, so the call didn't run.",
      "send ok",
    ]);
  });

  it("checks an approved call against the tool's current schema", async () => {
    const { send, h, state } = await stop();
    const decisions = ["appr_call_1", "appr_call_2"].map((approvalId) => ({
      approvalId,
      decision: "approve" as const,
      scope: "once" as const,
    }));
    resolveApprovals(state, state.pending?.batchId as string, decisions, NOW);
    const stricter = tool("send", "consequential");
    stricter.manifest.inputSchema = {
      type: "object",
      properties: { q: { type: "string" }, to: { type: "string" } },
      required: ["q", "to"],
    };
    const { events } = await drain({ ...h, tools: host(h.provider, [stricter]).tools }, state);
    expect(send.inputs).toEqual([]);
    expect(stricter.inputs).toEqual([]);
    expect(ofType(events, "tool.result")[0]?.payload.error).toContain("input.to: is required");
  });

  it("runs nothing it approved once the turn is cancelled", async () => {
    const { send, h, state } = await stop();
    const decisions = ["appr_call_1", "appr_call_2"].map((approvalId) => ({
      approvalId,
      decision: "approve" as const,
      scope: "once" as const,
    }));
    resolveApprovals(state, state.pending?.batchId as string, decisions, NOW);
    const ctl = new AbortController();
    ctl.abort();
    expect((await drain(h, state, ctl.signal)).outcome).toBe("cancelled");
    expect(send.inputs).toEqual([]);
    expect(state.pending).toBeNull();
    expect(state.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "Cancelled by the user.",
      "Cancelled by the user.",
    ]);
  });

  it("checks an approved call again against the current policy (M3-07 AC12)", async () => {
    const { send, h, state } = await stop();
    const batchId = state.pending?.batchId as string;
    resolveApprovals(
      state,
      batchId,
      ["appr_call_1", "appr_call_2"].map((approvalId) => ({
        approvalId,
        decision: "approve",
        scope: "once",
      })),
      NOW,
    );
    const { events } = await drain({ ...h, policy: () => ({ override: "never" }) }, state);
    expect(send.inputs).toEqual([]);
    expect(ofType(events, "tool.result").map((e) => e.payload.error)).toEqual([
      "Policy no longer allows this call.",
      "Policy no longer allows this call.",
    ]);
  });

  it("keeps the model's order across writes and decides each call on the taint when it starts", async () => {
    const order: string[] = [];
    const log =
      (name: string, untrusted = false) =>
      async (): Promise<ToolOutput> => {
        order.push(`${name} start`);
        await new Promise((r) => setTimeout(r, name === "slow" ? 20 : 1));
        order.push(`${name} end`);
        return { ok: true, content: name, ...(untrusted ? {} : { context: { kind: "system" } }) };
      };
    const save = tool("save", "write_reversible", log("save"));
    const tools = [tool("slow", "read", log("slow")), tool("fast", "read", log("fast")), save];
    tools.push(tool("fetch", "read", log("fetch", true)));
    const { provider } = scripted([
      {
        calls: [
          ["slow", { q: "1" }],
          ["fast", { q: "2" }],
          ["save", { q: "3" }],
          ["fast", { q: "4" }],
          ["fetch", { q: "5" }],
          ["save", { q: "6" }],
        ],
      },
    ]);
    const { events } = await drain(host(provider, tools, { now: () => Date.now() }), newTurn());
    expect(order).toEqual([
      "slow start",
      "fast start",
      "fast end",
      "slow end",
      "save start",
      "save end",
      "fast start",
      "fetch start",
      "fast end",
      "fetch end",
      // The second save comes after an untrusted read, so it asks instead of running.
    ]);
    expect(save.inputs).toEqual([{ q: "3" }]);
    // A fast read isn't charged for the slow one beside it.
    const durations = ofType(events, "step.completed").map((e) => e.payload.durationMs);
    expect(durations[2]).toBeLessThan(15);
  });
});

describe("cancel (M3-03 AC6)", () => {
  it("aborts the stream, keeps the partial text and emits turn.cancelled", async () => {
    const { provider } = scripted([{ text: "one two three four five six", delayMs: 5 }]);
    const ctl = new AbortController();
    const state = newTurn();
    const h = host(provider, []);
    const run = drain(h, state, ctl.signal);
    setTimeout(() => ctl.abort(), 12);
    const { events, outcome } = await run;
    expect(outcome).toBe("cancelled");
    expect(types(events).at(-1)).toBe("turn.cancelled");
    expect(types(events)).not.toContain("turn.interrupted");
    const kept = state.messages[0]?.content ?? "";
    expect(kept.length).toBeGreaterThan(0);
    expect("one two three four five six".startsWith(kept)).toBe(true);
    expect(kept).not.toBe("one two three four five six");
  });

  it("reaches a running tool and closes the calls that didn't finish", async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const wait = tool("wait", "write_reversible", (_, signal) => {
      seen = signal;
      ctl.abort();
      return { ok: false, content: "stopped" };
    });
    const { provider, requests } = scripted([
      {
        calls: [
          ["wait", { q: "a" }],
          ["wait", { q: "b" }],
        ],
      },
    ]);
    const state = newTurn();
    const { outcome } = await drain(host(provider, [wait]), state, ctl.signal);
    expect(outcome).toBe("cancelled");
    expect(seen?.aborted).toBe(true);
    expect(wait.inputs).toEqual([{ q: "a" }]); // the second call never started
    expect(requests).toHaveLength(1);
    expect(state.messages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "stopped",
      "Cancelled by the user.",
    ]);
  });
});

describe("per-turn limits (M3-03 AC7)", () => {
  it("stops at 8 model calls, keeps the count through storage, and Continue goes on", async () => {
    const look = tool("look", "read");
    const { provider, requests } = scripted(
      Array.from({ length: 20 }, () => ({ calls: [["look", { q: "x" }]] })),
    );
    const h = host(provider, [look]);
    const state = newTurn();
    const { events, outcome } = await drain(h, state);
    expect(outcome).toBe("limit_reached");
    expect(requests).toHaveLength(TURN_LIMITS.calls);
    expect(ofType(events, "limit.reached")[0]?.payload.kind).toBe("calls");
    // Summed across steps for the ledger.
    expect(state.usage).toEqual({
      inputTokens: 80,
      outputTokens: 40,
      cachedInputTokens: 16,
      reasoningTokens: 0,
    });

    const stored = structuredClone(state);
    expect((await drain(h, stored)).outcome).toBe("limit_reached");
    expect(requests).toHaveLength(TURN_LIMITS.calls);
    continueTurn(stored);
    await drain(h, stored);
    expect(requests).toHaveLength(2 * TURN_LIMITS.calls);
  });

  it("stops before running a step that would pass 20 tool calls", async () => {
    const look = tool("look", "read");
    const many = Array.from({ length: 12 }, (_, i): [string, unknown] => ["look", { q: `${i}` }]);
    const { provider } = scripted([{ calls: many }, { calls: many }]);
    const state = newTurn();
    const { events, outcome } = await drain(host(provider, [look]), state);
    expect(outcome).toBe("limit_reached");
    expect(look.inputs).toHaveLength(12);
    expect(ofType(events, "limit.reached")[0]?.payload.kind).toBe("tools");
    const results = state.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(24); // the second step's calls are closed, not left open
    expect(results.at(-1)?.content).toContain("tool call limit");
  });

  it("stops when the budget can't cover the next call and settles every call it reserved", async () => {
    const settle = vi.fn();
    const reserve = vi
      .fn()
      .mockReturnValueOnce({ maxOutputTokens: 512 })
      .mockReturnValue({ limit: "daily", detail: "daily cap" });
    const { provider, requests } = scripted([{ calls: [["look", { q: "x" }]] }]);
    const h = host(provider, [tool("look", "read")], { budget: { reserve, settle } });
    const { events, outcome } = await drain(h, newTurn());
    expect(outcome).toBe("limit_reached");
    expect(requests[0]?.maxOutputTokens).toBe(512);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(ofType(events, "limit.reached")[0]?.payload).toEqual({
      kind: "daily",
      detail: "daily cap",
    });
  });
});

describe("limits the host enforces (M3-17)", () => {
  it("stops resumably when the provider refuses the call for a limit, without counting it", async () => {
    let refuse = true;
    const { provider: inner, requests } = scripted([{ text: "hello" }]);
    const provider = {
      ...inner,
      stream: (req: Parameters<typeof inner.stream>[0]) =>
        (async function* () {
          if (refuse) throw new LimitStop("task_budget", "$0.10 task budget");
          yield* inner.stream(req);
        })(),
    };
    const state = newTurn();
    const { events, outcome } = await drain(host(provider, []), state);
    expect(outcome).toBe("limit_reached");
    expect(ofType(events, "limit.reached")[0]?.payload).toEqual({
      kind: "task_budget",
      detail: "$0.10 task budget",
    });
    expect(types(events)).not.toContain("turn.failed");
    expect(state.counts.calls).toBe(0);
    expect(state.messages).toEqual([]);
    refuse = false; // Continue raised the budget
    expect((await drain(host(provider, []), state)).outcome).toBe("completed");
    expect(requests).toHaveLength(1);
  });

  it("stops with tool_rate after a call the host refused to run, and closes the rest", async () => {
    let allowed = 1;
    const look = tool("look", "read", () =>
      allowed-- > 0
        ? { ok: true, content: "page", context: { kind: "system" } }
        : { ok: false, content: "slow down", slowDown: true },
    );
    const { provider } = scripted([
      {
        calls: [
          ["look", { q: "a" }],
          ["look", { q: "b" }],
        ],
      },
    ]);
    const state = newTurn();
    const { events, outcome } = await drain(host(provider, [look]), state);
    expect(outcome).toBe("limit_reached");
    expect(ofType(events, "limit.reached")[0]?.payload.kind).toBe("tool_rate");
    const results = state.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results).toEqual(["page", "slow down"]);
  });
});

describe("taint", () => {
  it("taints the context from a tool result and gates a later write with Just this once", async () => {
    const fetch = tool("fetch", "read", () => ({ ok: true, content: "<page>" }), true);
    const save = tool("save", "write_reversible");
    const { provider } = scripted([
      { calls: [["fetch", { q: "example.com" }]] },
      { calls: [["save", { q: "x" }]] },
    ]);
    const state = newTurn();
    const { events } = await drain(host(provider, [fetch, save]), state);
    expect(ofType(events, "context.tainted").map((e) => e.payload.source)).toEqual([
      { kind: "tool", label: "fetch" },
    ]);
    expect(save.inputs).toEqual([]);
    const [item] = ofType(events, "approval.requested")[0]?.payload.items ?? [];
    expect(item).toMatchObject({ tool: "save", rule: "default_tainted_write", scopes: ["once"] });
    expect(item?.taint).toEqual({ kind: "tool", label: "fetch" });
    expect(state.taint.taint).toBe("untrusted");
  });
});

describe("failures", () => {
  it("doesn't call a reply cut off at the output limit completed", async () => {
    const { provider } = scripted([{ text: "Half a sen" }]);
    const cut = {
      ...provider,
      async *stream(req: Parameters<typeof provider.stream>[0]) {
        for await (const e of provider.stream(req)) {
          yield e.type === "done" ? { ...e, finishReason: "length" as const } : e;
        }
      },
    };
    const state = newTurn();
    const { events, outcome } = await drain(host(cut, []), state);
    expect(outcome).toBe("failed");
    expect(ofType(events, "turn.failed")[0]?.payload.message).toContain("output limit");
    expect(state.messages).toEqual([{ role: "assistant", content: "Half a sen" }]);
  });

  it("turns a throwing tool into an error result and a failed stream into turn.failed", async () => {
    const boom = tool("boom", "read", () => {
      throw new Error("kaput");
    });
    const { provider } = scripted([{ calls: [["boom", { q: "x" }]] }, () => ({ text: "ok" })]);
    const { events } = await drain(host(provider, [boom]), newTurn());
    expect(ofType(events, "tool.result")[0]?.payload).toMatchObject({ ok: false, error: "kaput" });

    const broken = {
      ...provider,
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("reset")) }),
      }),
    };
    const state = newTurn();
    const failed = await drain(host(broken, []), state);
    expect(failed.outcome).toBe("failed");
    expect(ofType(failed.events, "turn.failed")[0]?.payload.message).toBe("reset");
    expect(state.messages).toEqual([]);
    expect(history).toHaveLength(1);
  });
});
