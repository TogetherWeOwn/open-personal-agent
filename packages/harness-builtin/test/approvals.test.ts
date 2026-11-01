// SPDX-License-Identifier: Apache-2.0
// A stopped batch as approval rows, and the rows back as decisions (M3-07 AC1, AC10, AC12).
import { ToolRegistry } from "@opa/policy";
import { describe, expect, it } from "vitest";
import {
  applyStoredDecisions,
  type BoundApproval,
  bindBatch,
  type LoopTool,
  newTurn,
  type StoredApproval,
  type TurnState,
} from "../src/index";
import { drain, host, NOW, scripted, tool } from "./helpers";

const context = { kind: "turn", id: "turn-1", conversationId: "conv-1" } as const;

async function stopped() {
  const send = tool("send", "consequential");
  const { provider } = scripted([
    {
      calls: [
        ["send", { q: "a" }],
        ["send", { q: "b" }],
      ],
    },
  ]);
  const h = host(provider, [send]);
  const state = newTurn();
  await drain(h, state);
  const pending = state.pending as NonNullable<TurnState["pending"]>;
  const rows = await bindBatch({ userId: "alice", tools: h.tools, pending, context });
  return { h, state, rows, send };
}

const stored = (row: BoundApproval, over: Partial<StoredApproval> = {}): StoredApproval => ({
  approvalId: row.approvalId,
  toolCallId: row.toolCallId,
  tool: row.tool,
  status: "approved",
  scope: "once",
  canonical: row.canonical,
  bindingHash: row.bindingHash,
  expiresAt: row.expiresAt,
  ...over,
});

const expect_ = (tools: ToolRegistry<LoopTool>) => ({ userId: "alice", context, tools });

describe("bindBatch", () => {
  it("binds each item to the user, the run and its own call, in batch order", async () => {
    const { rows } = await stopped();
    expect(rows.map((r) => [r.approvalId, r.position, r.turnId, r.taskId])).toEqual([
      ["appr_call_1", 0, "turn-1", null],
      ["appr_call_2", 1, "turn-1", null],
    ]);
    // Two calls to the same tool bind differently (crypto review C2).
    expect(rows[0]?.bindingHash).not.toBe(rows[1]?.bindingHash);
    expect(JSON.parse(rows[0]?.canonical ?? "")).toMatchObject({
      user_id: "alice",
      args: { q: "a" },
      context: { kind: "turn", id: "turn-1", conversation_id: "conv-1" },
      tool_call_id: "call_1",
    });
  });
});

describe("applyStoredDecisions", () => {
  it("waits while an item is pending and unexpired", async () => {
    const { h, state, rows } = await stopped();
    const [a, b] = rows as [BoundApproval, BoundApproval];
    const out = await applyStoredDecisions(
      state,
      [stored(a), stored(b, { status: "pending" })],
      expect_(h.tools),
      NOW,
    );
    expect(out.waiting).toBe(true);
    expect(state.pending?.items.every((i) => !i.decision)).toBe(true);
  });

  it("runs the arguments bound in the row, not the ones in the turn state", async () => {
    const { h, state, rows, send } = await stopped();
    const [a, b] = rows as [BoundApproval, BoundApproval];
    // The turn state was changed after the approval was asked: the row wins.
    const item = state.pending?.items[0];
    if (item) item.args = JSON.stringify({ q: "changed" });
    const out = await applyStoredDecisions(
      state,
      [stored(a), stored(b, { status: "denied", scope: null })],
      expect_(h.tools),
      NOW,
    );
    expect(out).toEqual({ waiting: false, refused: new Map() });
    await drain(h, state);
    expect(send.inputs).toEqual([{ q: "a" }]);
  });

  it("refuses a row that no longer opens, belongs elsewhere, or whose tool changed", async () => {
    const { h, state, rows } = await stopped();
    const [a, b] = rows as [BoundApproval, BoundApproval];
    const tampered = stored(a, { canonical: a.canonical.replace('"a"', '"z"') });
    const changed = new ToolRegistry<LoopTool>();
    const send = tool("send", "consequential");
    changed.register({ ...send, manifest: { ...send.manifest, description: "Changed." } });
    const out = await applyStoredDecisions(state, [tampered, stored(b)], expect_(changed), NOW);
    expect([...out.refused]).toEqual([
      ["call_1", "binding_mismatch"],
      ["call_2", "tool_changed"],
    ]);
    const other = structuredClone(state);
    for (const i of other.pending?.items ?? []) delete i.decision;
    const elsewhere = { ...expect_(h.tools), userId: "bob" };
    const theirs = await applyStoredDecisions(other, [stored(a), stored(b)], elsewhere, NOW);
    expect([...theirs.refused.values()]).toEqual(["binding_mismatch", "binding_mismatch"]);
  });

  it("refuses a row whose tool now derives another target from the same arguments", async () => {
    const { state, rows } = await stopped();
    const [a, b] = rows as [BoundApproval, BoundApproval];
    const moved = new ToolRegistry<LoopTool>();
    const send = tool("send", "consequential");
    moved.register({ ...send, target: () => "elsewhere.example" });
    const out = await applyStoredDecisions(state, [stored(a), stored(b)], expect_(moved), NOW);
    expect([...out.refused.values()]).toEqual(["target_changed", "target_changed"]);
  });

  it("counts an item expired early by a compromise signal as expired (AC13)", async () => {
    const { h, state, rows, send } = await stopped();
    const [a, b] = rows as [BoundApproval, BoundApproval];
    const out = await applyStoredDecisions(
      state,
      [stored(a, { status: "expired" }), stored(b, { status: "executed" })],
      expect_(h.tools),
      NOW,
    );
    // A row a run already claimed is refused, so the host never runs it twice.
    expect([...out.refused]).toEqual([["call_2", "already_claimed"]]);
    const approvals = {
      claim: async (id: string) => out.refused.get(id) ?? null,
      finish: async () => {},
    };
    const { events } = await drain({ ...h, approvals }, state);
    expect(send.inputs).toEqual([]);
    const results = events.flatMap((e) => (e.type === "tool.result" ? [e.payload.error] : []));
    expect(results[0]).toBe("The approval expired, so the call didn't run.");
  });

  it("throws on rows that don't match the turn's batch, or in a status it doesn't know", async () => {
    const { h, state, rows } = await stopped();
    const [a, b] = rows as [BoundApproval, BoundApproval];
    await expect(applyStoredDecisions(state, [stored(a)], expect_(h.tools), NOW)).rejects.toThrow();
    const odd = [stored(a), stored(b, { status: "maybe" })];
    await expect(applyStoredDecisions(state, odd, expect_(h.tools), NOW)).rejects.toThrow();
  });
});
