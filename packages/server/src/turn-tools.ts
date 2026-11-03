// SPDX-License-Identifier: Apache-2.0
// One turn's production tools (M3-08): the builtin registry plus the memory and task tools,
// with ports scoped to the calling user and the policy input read from that user's stored
// overrides and grants — so Settings › Apps & tools governs what a turn offers. Both chat
// assistants (Node, Worker) and the task Workflow compose through here, so the offered set
// can't drift between runtimes; only the runtime's fetch and own-host list differ per caller.

import type { MemorySource } from "@opa/db/memory";
import { type MemoryToolUser, registerMemoryTools } from "@opa/db/memory-tools";
import type { ArtifactSource, createRepository } from "@opa/db/repository";
import { registerTaskTools } from "@opa/db/task-tools";
import type { LoopHost, LoopTool } from "@opa/harness-builtin";
import type { ToolRegistry } from "@opa/policy";
import { builtinToolRegistry } from "@opa/tools-builtin";

/** The calling user's scoped repository slice, as `createRepository(env).forUser(scope)`. */
export type TurnUser = ReturnType<ReturnType<typeof createRepository>["forUser"]>;

/** Where the turn runs: whose files a tool writes and which conversation it continues. */
export type TurnScope =
  | { kind: "chat"; conversationId: string; turnId?: string }
  | { kind: "task"; taskId: string; conversationId: string };

/** What the host knows about the turn: where it runs and its live taint. */
export interface TurnContext {
  conversationId: string;
  turnId?: string;
  /**
   * The turn's live taint. The loop owns it — a turn starts trusted and a web, file or tool
   * result taints it — so the host reads it fresh at each memory-tool call rather than
   * snapshotting it when the turn starts. Readers fail closed (`!== "trusted"`): a turn whose
   * taint can't be read counts as tainted.
   */
  taint: () => boolean;
}

export interface TurnToolsInput {
  user: TurnUser;
  /** The runtime's page fetch: the SSRF-guarded fetch on Node, the runtime fetch on Workers. */
  fetch: typeof fetch;
  /**
   * Every hostname serving the deployment. The tool refuses them, so a page can't make it read
   * the app itself; localhost, private literals and what the fetch port refuses are refused
   * regardless.
   */
  ownHosts: readonly string[];
  /** Mints artifact ids (single safe segments). */
  newId: () => string;
  scope: TurnScope;
  /** The turn's live taint (see `TurnContext.taint`). */
  taint: () => boolean;
}

/**
 * A comma-separated hostname list (an `OPA_OWN_HOSTS`-style var) as `ownHosts`: trims, drops
 * blanks, keeps the rest for the tool's own normalization.
 */
export function parseOwnHosts(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
}

/**
 * The registry the turn offers, the tools in it (for hosts that wrap each tool's `execute`,
 * like the task Workflow's step accounting), and the policy input for it. Overrides and grants
 * load once per turn (per task run for a task): the loop reads the returned closure fresh for
 * each decision, and a later turn re-reads the store, so a Settings change lands on the next turn.
 */
export async function composeTurnTools(input: TurnToolsInput): Promise<{
  tools: ToolRegistry<LoopTool>;
  list: readonly LoopTool[];
  policy: LoopHost["policy"];
}> {
  const { user, scope } = input;
  const conversationId = scope.conversationId;
  const fileSource: ArtifactSource =
    scope.kind === "chat"
      ? {
          conversationId,
          ...(scope.turnId === undefined ? {} : { turnId: scope.turnId }),
        }
      : { conversationId, taskId: scope.taskId };
  const files = user.files(fileSource);
  const registry = builtinToolRegistry({
    fetch: input.fetch,
    ownHosts: input.ownHosts,
    searchHistory: (query, limit) => user.chat.searchHistory(query, limit),
    getFile: (id) => files.getFile(id),
    putFile: (id, content, mediaType, name) => files.putFile(id, content, mediaType, name),
    newId: input.newId,
  });
  // The memory tools file under the turn's conversation. Untainted, the model's call answers
  // the user's own message, so it saves (A-Me1); tainted, outside content may have induced it,
  // so the trust gate only ever proposes (A-Me2) — read live, since a fetch mid-turn taints it.
  const memorySource: MemorySource = { source: "chat", conversationId };
  await registerMemoryTools(registry, user as MemoryToolUser, () => {
    const tainted = input.taint();
    return { tainted, userAsserted: !tainted, source: memorySource };
  });
  await registerTaskTools(registry, user.tasks, () => ({ conversationId }));
  const [overrides, grants] = await Promise.all([
    user.policy.overrides(),
    user.policy.grants(Date.now()),
  ]);
  const list: LoopTool[] = [];
  for (const manifest of registry.manifests()) {
    const entry = registry.get(manifest.name);
    if (entry) list.push(entry.tool);
  }
  return {
    tools: registry,
    list,
    // The override is present only when the user set one: `exactOptionalPropertyTypes` keeps an
    // explicit `undefined` from satisfying the policy input, and an unset tool decides by its
    // risk class and grants. The same `grants` array serves every decision of the turn.
    policy: (tool: string) => {
      const override = overrides.get(tool);
      return { ...(override === undefined ? {} : { override }), grants };
    },
  };
}
