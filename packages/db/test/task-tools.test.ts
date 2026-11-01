// SPDX-License-Identifier: Apache-2.0
// The `task` tool (M3-13 AC3): the manifest for the M3-08 registry, and filing the queued row
// through the scoped service. The service is stubbed; creating the Workflow instance is
// promotion (M3-12b), so the row the tool files carries no instance id.
import { describe, expect, it } from "vitest";
import {
  registerTaskTools,
  TASK_TOOL_NAMES,
  type TaskTool,
  type TaskToolContext,
  type TaskToolService,
  taskTools,
} from "../src/task-tools";

const signal = () => new AbortController().signal;

function stubService(impl: Partial<TaskToolService> = {}): TaskToolService {
  return {
    create: async () => true,
    ...impl,
  };
}

const context: TaskToolContext = { conversationId: "c1" };

const byName = (service: TaskToolService, ctx: TaskToolContext) =>
  new Map(taskTools(service, () => ctx).map((t: TaskTool) => [t.manifest.name, t]));

describe("the task tool manifest (M3-08 AC5)", () => {
  it("ships exactly task, reversible and staying home", () => {
    expect(TASK_TOOL_NAMES).toEqual(["task"]);
    const tools = taskTools(stubService(), () => context);
    expect(tools.map((t) => t.manifest.name)).toEqual([...TASK_TOOL_NAMES]);
    const [manifest] = tools.map((t) => t.manifest);
    expect(manifest?.riskClass).toBe("write_reversible");
    expect(manifest?.destinations).toEqual([
      { id: "tasks", kind: "control_plane", dataEgress: false },
    ]);
    expect(manifest?.scopes).toEqual(["tasks:write"]);
    expect(manifest?.inputSchema).toMatchObject({
      type: "object",
      required: ["title"],
      additionalProperties: false,
    });
    const registered: TaskTool[] = [];
    registerTaskTools({ register: (t) => registered.push(t) }, stubService(), () => context);
    expect(registered.map((t) => t.manifest.name)).toEqual([...TASK_TOOL_NAMES]);
  });
});

describe("task (M3-13 AC3)", () => {
  it("files the queued row for the host's conversation, with no instance yet", async () => {
    const calls: Parameters<TaskToolService["create"]>[] = [];
    const service = stubService({
      create: async (input) => {
        calls.push([input]);
        return true;
      },
    });
    const out = await byName(service, context)
      .get("task")
      ?.execute({ title: "  Summarise the thread  " }, signal());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      conversationId: "c1",
      kind: "turn",
      mode: "background",
      title: "Summarise the thread",
    });
    expect(typeof calls[0]?.[0].id).toBe("string");
    expect(calls[0]?.[0].workflowInstanceId).toBeUndefined();
    expect(out).toMatchObject({ ok: true, context: { kind: "system" } });
    expect(out?.content).toContain("Summarise the thread");
  });

  it("asks for a title, and reports a conversation it cannot file in", async () => {
    const service = stubService();
    const out = await byName(service, context).get("task")?.execute({}, signal());
    expect(out).toMatchObject({ ok: false, context: { kind: "system" } });
    expect(out?.content).toContain("what to call");
    const refused = stubService({ create: async () => false });
    const missing = await byName(refused, context)
      .get("task")
      ?.execute({ title: "Report" }, signal());
    expect(missing?.ok).toBe(false);
    expect(missing?.content).toContain("that conversation");
  });
});
