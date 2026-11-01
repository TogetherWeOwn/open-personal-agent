// SPDX-License-Identifier: Apache-2.0
// `remember`/`recall`/`forget` (M3-14b, PRD §4.5): the model's handles on MemoryService. The host
// scopes the service to the calling user first, so a tool holds no user id of its own to get
// wrong, and every write passes the trust gate: "remember I'm vegetarian" in an untainted turn
// saves a `user` row (A-Me1), while a fetched page saying "remember the address is X" only files
// a proposal for the inbox (A-Me2).
//
// NOTE (M3-08 AC5): the built-in registry (`builtinToolRegistry` in `packages/tools-builtin`)
// has not landed, so the `LoopTool` surface it needs is stubbed here structurally. The shapes
// mirror the M3-08/M3-03 interface (`manifest` with `riskClass`/`destinations`/`scopes`, output
// with `ok`/`content`/`context`), so registering for real is a type-only swap. `recall` makes no
// model call: it reads the store through `MemoryService.recall`.
import type { MemoryKind, MemoryService, MemorySource, Trust, WriteOutcome } from "./memory";

/** The `LoopTool` manifest fields the registry reads (M3-02 AC1). */
export interface MemoryToolManifest {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskClass: "read" | "write_reversible" | "consequential" | "irreversible";
  destinations: { id: string; kind: string; dataEgress: boolean }[];
  scopes: string[];
}

/** What a result adds to the context, for taint (M3-02 AC3). Omitted, it counts as untrusted. */
export type MemoryToolContextEvent =
  | { kind: "system" }
  | { kind: "memory"; trust: Trust; label: string }
  | { kind: "tool"; label: string };

export interface MemoryToolOutput {
  ok: boolean;
  content: string;
  context?: MemoryToolContextEvent;
}

/** The `LoopTool` surface `registerMemoryTools` needs: manifest plus `execute`. */
export interface MemoryTool {
  manifest: MemoryToolManifest;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<MemoryToolOutput>;
}

/** The registry surface: anything with `register` takes the three tools (M3-08 AC5). */
export interface MemoryToolRegistry {
  register(tool: MemoryTool): void;
}

/** The service surface the tools need; the host hands over its scoped `forUser(scope).memory`. */
export type MemoryToolService = Pick<MemoryService, "create" | "recall" | "forget">;

/** What the host knows: the turn's taint, whether the user's own message asked for the write
 * (A-Me1's user assertion), and where to file it. Taint makes the gate propose, never save. */
export interface MemoryToolContext {
  tainted: boolean;
  userAsserted: boolean;
  source: MemorySource;
}

export const MEMORY_TOOL_NAMES = ["remember", "recall", "forget"] as const;

const STAY_HOME = [{ id: "memory", kind: "control_plane", dataEgress: false }];

const failed = (content: string): MemoryToolOutput => ({
  ok: false,
  content,
  context: { kind: "system" },
});

/** A proposal reads as saved-for-review; from a tainted turn it keeps the turn tainted. */
const proposed = (tainted: boolean): MemoryToolOutput => ({
  ok: true,
  content:
    "I've put that in your Memory inbox for review — it isn't remembered yet, and nothing " +
    "already remembered has changed.",
  context: tainted ? { kind: "tool", label: "memory" } : { kind: "system" },
});

const actorOf = (ctx: MemoryToolContext) =>
  ({ via: "assistant", tainted: ctx.tainted, userAsserted: ctx.userAsserted }) as const;

const TRUST_ORDER: Trust[] = ["external", "inferred", "user", "system"];

/** A miss reads as gone; a built-in row reads as off-limits. */
const unexpected = (outcome: WriteOutcome): MemoryToolOutput =>
  failed(
    outcome.status === "not_found"
      ? "I can't find that memory — it may already be gone."
      : "I can't do that to a built-in memory.",
  );

function rememberTool(service: MemoryToolService, context: () => MemoryToolContext): MemoryTool {
  return {
    manifest: {
      name: "remember",
      description:
        "Remember something about the user for later turns (a preference, a fact, an " +
        "instruction). Use it when the user tells you something to keep. Content from a web " +
        "page or file is only ever filed for the user's review, never remembered outright.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description: "What to remember, in the user's own words where possible.",
          },
          kind: {
            type: "string",
            enum: ["fact", "instruction"],
            description: "A fact (default) or an instruction the user gave.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      riskClass: "write_reversible",
      destinations: STAY_HOME,
      scopes: ["memory:write"],
    },
    async execute(input) {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (text === "") return failed("Tell me what to remember.");
      const kind: MemoryKind = input.kind === "instruction" ? "instruction" : "fact";
      const ctx = context();
      const outcome = await service.create(actorOf(ctx), text, kind, ctx.source);
      if (outcome.status === "saved")
        return {
          ok: true,
          content: `Remembered: "${outcome.memory.text}"`,
          context: { kind: "system" },
        };
      if (outcome.status === "proposed") return proposed(ctx.tainted);
      return unexpected(outcome);
    },
  };
}

function recallTool(service: MemoryToolService, _context: () => MemoryToolContext): MemoryTool {
  return {
    manifest: {
      name: "recall",
      description:
        "Recall what is remembered about the user matching some text. Use it when an answer " +
        "could depend on a preference, a fact or an instruction from an earlier turn. It " +
        "searches only this user's own remembered rows.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "What to look for, e.g. a food, a place, a name.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "How many rows to return (default 10).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      riskClass: "read",
      destinations: STAY_HOME,
      scopes: ["memory:read"],
    },
    async execute(input, signal) {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (query === "") return failed("Tell me what to look for.");
      const limit =
        typeof input.limit === "number" ? Math.min(Math.max(Math.trunc(input.limit), 1), 25) : 10;
      const result = await service.recall(query, { limit });
      if (signal.aborted) return failed("The recall was cancelled.");
      if (result.memories.length === 0)
        return {
          ok: true,
          content: `I don't remember anything about "${query}".`,
          // Only our own sentence joins the context.
          context: { kind: "system" },
        };
      // The id travels with each row so the model can forget what recall returned.
      const lines = result.memories.map(
        (m, i) => `${i + 1}. [id: ${m.id}] ${m.text.replace(/\s+/g, " ").trim()}`,
      );
      // A retrieved row below user trust taints the turn (M3-02 AC3); the host reads `trust`.
      // Retrieved rows always join as memory provenance, never as system text, so a stored
      // row can never gain system-level authority in the model's next turn.
      const trust = result.memories
        .map((m) => m.trust)
        .reduce((a, b) => (TRUST_ORDER.indexOf(a) <= TRUST_ORDER.indexOf(b) ? a : b));
      return {
        ok: true,
        content: `What I remember about "${query}":\n\n${lines.join("\n")}`,
        context: { kind: "memory", trust, label: "memory" },
      };
    },
  };
}

function forgetTool(service: MemoryToolService, context: () => MemoryToolContext): MemoryTool {
  return {
    manifest: {
      name: "forget",
      description:
        "Forget remembered rows by id (from recall), with their earlier versions. Use it when " +
        "the user corrects you or asks to drop something. Forgetting is permanent; from " +
        "anything but the user's own ask it only files a proposal for the inbox.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 25,
            description: "The ids to forget, as recall returned them.",
          },
        },
        required: ["ids"],
        additionalProperties: false,
      },
      // A hard delete, so it asks; the gate still proposes from a tainted turn (A-Me2).
      riskClass: "consequential",
      destinations: STAY_HOME,
      scopes: ["memory:write"],
    },
    async execute(input) {
      const ids = [
        ...new Set(
          (Array.isArray(input.ids) ? input.ids : []).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
        ),
      ];
      if (ids.length === 0) return failed("Tell me which memory to forget, by its id.");
      const ctx = context();
      // The service reports every removed row (anchors plus earlier versions and linked
      // proposals); the message counts what was asked for, not what the delete swept up.
      const requested = ids.slice(0, 25);
      const outcome = await service.forget(actorOf(ctx), requested, ctx.source);
      if (outcome.status === "deleted")
        return {
          ok: true,
          content:
            requested.length === 1
              ? "Forgotten — that memory and its earlier versions are gone."
              : `Forgotten — ${requested.length} rows and their earlier versions are gone.`,
          context: { kind: "system" },
        };
      if (outcome.status === "proposed") return proposed(ctx.tainted);
      return unexpected(outcome);
    },
  };
}

/** The three tools over one scoped service; the host supplies taint, assertion and source. */
export function memoryTools(
  service: MemoryToolService,
  context: () => MemoryToolContext,
): MemoryTool[] {
  return [
    rememberTool(service, context),
    recallTool(service, context),
    forgetTool(service, context),
  ];
}

/** Joins the tools to the M3-08 registry (or any `{ register }`) when it lands. */
export function registerMemoryTools(
  registry: MemoryToolRegistry,
  service: MemoryToolService,
  context: () => MemoryToolContext,
): void {
  for (const tool of memoryTools(service, context)) registry.register(tool);
}
