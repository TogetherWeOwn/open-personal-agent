// SPDX-License-Identifier: Apache-2.0
// The `task` tool (M3-13 AC3): the model's handle for promoting work to a background task
// explicitly. It only files the queued row through the scoped tasks service — the row has no
// Workflow instance yet, and promotion (creating it and filling in the live turn state) is
// M3-12b. The host scopes the service to the calling user first, so the tool holds no user id
// of its own to get wrong, and hands over the conversation the promotion continues.
//
// NOTE (M3-08 AC5): as with memory-tools.ts, the built-in registry has not landed, so the
// `LoopTool` surface is stubbed here structurally. The shapes mirror the M3-08/M3-03 interface
// (`manifest` with `riskClass`/`destinations`/`scopes`, output with `ok`/`content`/`context`),
// so registering for real is a type-only swap.
/** The `LoopTool` manifest fields the registry reads (M3-02 AC1). */
export interface TaskToolManifest {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskClass: "read" | "write_reversible" | "consequential" | "irreversible";
  destinations: { id: string; kind: string; dataEgress: boolean }[];
  scopes: string[];
}

/** What a result adds to the context. A queued row joins as system text. */
export type TaskToolContextEvent = { kind: "system" };

export interface TaskToolOutput {
  ok: boolean;
  content: string;
  context?: TaskToolContextEvent;
}

/** The `LoopTool` surface `registerTaskTools` needs: manifest plus `execute`. */
export interface TaskTool {
  manifest: TaskToolManifest;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<TaskToolOutput>;
}

/** The registry surface: anything with `register` takes the tool (M3-08 AC5). */
export interface TaskToolRegistry {
  register(tool: TaskTool): void;
}

/** The service surface the tool needs; the host hands over its scoped `forUser(scope).tasks`. */
export interface TaskToolService {
  create(input: {
    id: string;
    conversationId: string;
    workflowInstanceId?: string | null;
    kind: string;
    mode: "background";
    title?: string | null;
    state?: string | null;
  }): Promise<boolean>;
}

/** What the host knows: the conversation the promoted work continues. */
export interface TaskToolContext {
  conversationId: string;
}

export const TASK_TOOL_NAMES = ["task"] as const;

const STAY_HOME = [{ id: "tasks", kind: "control_plane", dataEgress: false }];

const failed = (content: string): TaskToolOutput => ({
  ok: false,
  content,
  context: { kind: "system" },
});

function taskTool(service: TaskToolService, context: () => TaskToolContext): TaskTool {
  return {
    manifest: {
      name: "task",
      description:
        "Hand work to a background task that outlives this turn. Use it when the user asks you " +
        "to keep working on something in the background, or when a job will take longer than " +
        "this turn allows. The task queues immediately; tell the user they " +
        "can follow it in the Tasks view.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 140,
            description: "A short title for the task, shown in the Tasks list.",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
      // Filing the row is reversible (cancel); the run itself is stopped the same way.
      riskClass: "write_reversible",
      destinations: STAY_HOME,
      scopes: ["tasks:write"],
    },
    async execute(input) {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (title === "") return failed("Tell me what to call the task.");
      const { conversationId } = context();
      const created = await service.create({
        id: crypto.randomUUID(),
        conversationId,
        kind: "turn",
        mode: "background",
        title,
      });
      if (!created) return failed("I can't start a task in that conversation.");
      return {
        ok: true,
        content: `Queued "${title}" as a background task — the Tasks view follows it.`,
        context: { kind: "system" },
      };
    },
  };
}

/** The tool over one scoped service; the host supplies the conversation it continues. */
export function taskTools(service: TaskToolService, context: () => TaskToolContext): TaskTool[] {
  return [taskTool(service, context)];
}

/** Joins the tool to the M3-08 registry (or any `{ register }`) when it lands. */
export function registerTaskTools(
  registry: TaskToolRegistry,
  service: TaskToolService,
  context: () => TaskToolContext,
): void {
  for (const tool of taskTools(service, context)) registry.register(tool);
}
