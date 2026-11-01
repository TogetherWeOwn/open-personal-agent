// SPDX-License-Identifier: Apache-2.0
// The M3 events carry the exact payloads of EL fix 6 (M3-03 AC8) under `v: 1`. These samples are
// the contract: if a payload changes here, the spec table and every consumer change with it.
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../src/harness-event";

const at = (seq: number) => ({ v: 1 as const, seq, sessionId: "conv-1", turnId: "turn-1" });

const M3_EVENTS: HarnessEvent[] = [
  { ...at(1), type: "turn.cancelled", payload: {} },
  { ...at(2), type: "step.started", payload: { stepId: "s1", label: "Thinking" } },
  {
    ...at(3),
    type: "step.started",
    payload: { stepId: "s2", label: "web_fetch", toolCallId: "call-1" },
  },
  { ...at(4), type: "step.completed", payload: { stepId: "s2", status: "ok", durationMs: 12 } },
  {
    ...at(5),
    type: "tool.called",
    payload: {
      toolCallId: "call-1",
      tool: "web_fetch",
      args: '{"url":"https://x.test"}',
      risk: "read",
    },
  },
  {
    ...at(6),
    type: "tool.result",
    payload: { toolCallId: "call-1", ok: true, preview: "A page", bytes: 42 },
  },
  {
    ...at(7),
    type: "tool.result",
    payload: { toolCallId: "call-2", ok: false, preview: "Nope", bytes: 4, error: "Nope" },
  },
  {
    ...at(8),
    type: "approval.requested",
    payload: {
      batchId: "batch_1",
      items: [
        {
          approvalId: "appr_call-2",
          tool: "remember",
          args: '{"text":"Sam lives in Paris"}',
          target: "memory",
          risk: "write_reversible",
          rule: "default_tainted_write",
          taint: { kind: "web", label: "x.test" },
          scopes: ["once"],
          expiresAt: 1_800_000_000_000,
        },
      ],
    },
  },
  {
    ...at(9),
    type: "approval.resolved",
    payload: {
      batchId: "batch_1",
      decisions: [{ approvalId: "appr_call-2", decision: "approve", scope: "once" }],
    },
  },
  {
    ...at(10),
    type: "context.tainted",
    payload: { stepId: "s2", source: { kind: "web", label: "x.test" } },
  },
  { ...at(11), type: "task.promoted", payload: { taskId: "task-1" } },
  { ...at(12), type: "limit.reached", payload: { kind: "tools", detail: "20 tool calls" } },
  {
    ...at(13),
    type: "artifact.created",
    payload: { artifactId: "art-1", name: "summary.md", type: "text/markdown", bytes: 120 },
  },
  {
    ...at(14),
    type: "memory.proposed",
    payload: { memoryId: "mem-1", text: "Sam lives in Paris", source: "x.test" },
  },
];

describe("HarnessEvent v1 (M3-03 AC8)", () => {
  it("carries every M3 event in the v1 envelope, as plain JSON", () => {
    expect(M3_EVENTS.map((e) => e.type)).toEqual([
      "turn.cancelled",
      "step.started",
      "step.started",
      "step.completed",
      "tool.called",
      "tool.result",
      "tool.result",
      "approval.requested",
      "approval.resolved",
      "context.tainted",
      "task.promoted",
      "limit.reached",
      "artifact.created",
      "memory.proposed",
    ]);
    for (const event of M3_EVENTS) {
      expect(event.v).toBe(1);
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    }
  });
});
