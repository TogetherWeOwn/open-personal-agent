// SPDX-License-Identifier: Apache-2.0
// The registry and a whole turn through the loop: every tool has a manifest the model is offered
// and the card events the transcript renders (M3-08 AC4, A-T1), web content taints the turn
// (AC1), and a created file is announced (AC3).
import type { ModelEvent, ModelProvider, ModelRequest } from "@opa/core";
import {
  type LoopEvent,
  type LoopHost,
  newTurn,
  runTurn,
  type TurnState,
} from "@opa/harness-builtin";
import { manifestProblems } from "@opa/policy";
import { describe, expect, it } from "vitest";
import { builtinToolRegistry, builtinTools } from "../src/index";
import { fakePorts } from "./helpers";

describe("the built-in registry (M3-08 AC4, AC5)", () => {
  it("ships exactly the four tools, each with a valid manifest", () => {
    const registry = builtinToolRegistry(fakePorts());
    const manifests = registry.manifests();
    expect(manifests.map((m) => m.name)).toEqual([
      "web_fetch",
      "search_history",
      "create_artifact",
      "read_file",
    ]);
    for (const manifest of manifests) expect(manifestProblems(manifest)).toEqual([]);
    const byName = new Map(manifests.map((m) => [m.name, m]));
    // web_fetch sends the request out (egress: the trifecta rule applies); the rest stay home.
    expect(byName.get("web_fetch")?.destinations).toEqual([
      { id: "web", kind: "third_party", dataEgress: true },
    ]);
    expect(byName.get("web_fetch")?.riskClass).toBe("read");
    expect(byName.get("create_artifact")?.riskClass).toBe("write_reversible");
    for (const name of ["search_history", "create_artifact", "read_file"]) {
      expect(
        byName.get(name)?.destinations.every((d) => !d.dataEgress),
        name,
      ).toBe(true);
    }
  });
});

type Reply = { text?: string; calls?: [name: string, args: unknown][] };

function scripted(replies: Reply[]) {
  const requests: ModelRequest[] = [];
  let ids = 0;
  const provider: ModelProvider = {
    id: "mock",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(req): AsyncIterable<ModelEvent> {
      const { signal: _, ...copy } = req;
      requests.push(structuredClone(copy));
      const reply = replies[requests.length - 1] ?? { text: "done" };
      if (reply.text) yield { type: "text.delta", text: reply.text };
      for (const [name, args] of reply.calls ?? []) {
        yield {
          type: "tool_call",
          toolCall: { id: `call_${++ids}`, name, arguments: JSON.stringify(args) },
        };
      }
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 },
      };
      yield { type: "done", finishReason: reply.calls ? "tool_calls" : "stop" };
    },
  };
  return { provider, requests };
}

async function drain(host: LoopHost, state: TurnState) {
  const events: LoopEvent[] = [];
  const run = runTurn(host, [{ role: "user", content: "hi" }], state, new AbortController().signal);
  for (;;) {
    const next = await run.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

describe("a turn with the built-in tools", () => {
  it("offers the manifests, cards each call, taints on web content and announces the artifact", async () => {
    const { provider, requests } = scripted([
      { calls: [["web_fetch", { url: "https://ferries.example/" }]] },
      { calls: [["create_artifact", { name: "notes.md", content: "# Ferries" }]] },
      { text: "Saved." },
    ]);
    let id = 0;
    const host: LoopHost = {
      provider,
      model: "m",
      tools: builtinToolRegistry(fakePorts()),
      // Untainted, creating a file runs; keep policy empty so the SEC-4 defaults decide.
      policy: () => ({}),
      now: () => 0,
      newId: () => `s${++id}`,
    };
    const state = newTurn();
    const { events, outcome } = await drain(host, state);

    // The model was offered every built-in tool by manifest name.
    expect(requests[0]?.tools?.map((t) => t.name)).toEqual([
      "web_fetch",
      "search_history",
      "create_artifact",
      "read_file",
    ]);
    // Each call produced its transcript card events.
    const called = events.filter((e) => e.type === "tool.called").map((e) => e.payload.tool);
    expect(called).toEqual(["web_fetch", "create_artifact"]);
    // Both calls are carded as called; only the fetch ran, so only it has a result.
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(1);
    // The fetched page tainted the turn, from the web.
    const tainted = events.find((e) => e.type === "context.tainted");
    expect(tainted?.payload.source).toEqual({ kind: "web", label: "ferries.example" });
    expect(state.taint.taint).toBe("untrusted");
    // Tainted, the write then asked instead of running silently (SEC-4 default) — so in this
    // turn nothing was created. The same call untainted announces artifact.created:
    expect(outcome).toBe("awaiting_approval");
    expect(events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(events.some((e) => e.type === "artifact.created")).toBe(false);

    const second = scripted([
      { calls: [["create_artifact", { name: "notes.md", content: "# Ferries" }]] },
      { calls: [["read_file", { artifactId: "art-1" }]] },
      { text: "Done." },
    ]);
    const clean = await drain({ ...host, provider: second.provider }, newTurn());
    expect(clean.outcome).toBe("completed");
    const created = clean.events.find((e) => e.type === "artifact.created");
    expect(created?.payload).toEqual({
      artifactId: "art-1",
      name: "notes.md",
      type: "text/markdown",
      bytes: 9,
    });
    // The model read its own file back on the next step.
    const readBack = second.requests[2]?.messages.filter((m) => m.role === "tool");
    expect(readBack?.at(-1)?.content).toBe("# Ferries");
  });

  it("search_history runs as an ungated read with its card events", async () => {
    const { provider } = scripted([
      { calls: [["search_history", { query: "ferry" }]] },
      { text: "None found." },
    ]);
    let id = 0;
    const host: LoopHost = {
      provider,
      model: "m",
      tools: builtinToolRegistry(fakePorts()),
      policy: () => ({}),
      now: () => 0,
      newId: () => `s${++id}`,
    };
    const { events, outcome } = await drain(host, newTurn());
    expect(outcome).toBe("completed");
    expect(events.filter((e) => e.type === "tool.called").map((e) => e.payload.tool)).toEqual([
      "search_history",
    ]);
    const tools = builtinTools(fakePorts());
    expect(tools.map((t) => t.manifest.name)).toContain("search_history");
  });
});
