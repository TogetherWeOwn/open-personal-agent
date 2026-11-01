// SPDX-License-Identifier: Apache-2.0
// `search_history` (M3-08 AC2): find earlier messages by their text. The port is the caller's
// scoped repository slice, so the search can only ever see the caller's own conversations; the
// tool holds no user id of its own to get wrong.
import type { LoopTool } from "@opa/harness-builtin";

/** One match, as the scoped repository returns it (`HistoryHit` in `@opa/db/repository`). */
export type HistoryHit = {
  conversationId: string;
  conversationTitle: string | null;
  messageId: string;
  role: "user" | "assistant";
  snippet: string;
  createdAt: number;
};

export type SearchHistoryPorts = {
  /** The caller's own messages containing `query`, newest first. */
  searchHistory(query: string, limit: number): Promise<HistoryHit[]>;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export function searchHistoryTool(ports: SearchHistoryPorts): LoopTool {
  return {
    manifest: {
      name: "search_history",
      description:
        "Search the user's earlier conversations for messages containing some text. Use it when " +
        "the user refers to something said before, in this or another conversation. It searches " +
        "only this user's own conversations.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            // SQLite LIKE folds A–Z only: other scripts match exactly as typed.
            description:
              "The exact text to look for (case-insensitive for A–Z; other letters match as typed).",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: `How many matches to return (default ${DEFAULT_LIMIT}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      riskClass: "read",
      destinations: [{ id: "history", kind: "control_plane", dataEgress: false }],
      scopes: ["history:read"],
    },
    async execute(input, signal) {
      const query = String(input.query ?? "");
      if (query.trim() === "") {
        return { ok: false, content: "Give some text to search for.", context: { kind: "system" } };
      }
      const limit =
        typeof input.limit === "number"
          ? Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LIMIT)
          : DEFAULT_LIMIT;
      let hits: HistoryHit[];
      try {
        hits = await ports.searchHistory(query, limit);
      } catch {
        return {
          ok: false,
          content: "The search failed.",
          context: { kind: "system" },
        };
      }
      if (signal.aborted) {
        return { ok: false, content: "The search was cancelled.", context: { kind: "system" } };
      }
      if (hits.length === 0) {
        return {
          ok: true,
          content: `No messages in the user's conversations contain "${query}".`,
          // Only our own sentence joins the context.
          context: { kind: "system" },
        };
      }
      const lines = hits.map((hit) => {
        const day = new Date(hit.createdAt).toISOString().slice(0, 10);
        const where = hit.conversationTitle
          ? `"${hit.conversationTitle}" (conversation ${hit.conversationId})`
          : `conversation ${hit.conversationId}`;
        const who = hit.role === "user" ? "User" : "Assistant";
        const snippet = hit.snippet.replace(/\s+/g, " ").trim();
        return `- [${day}] ${where} — ${who}: ${snippet}`;
      });
      return {
        ok: true,
        // Earlier messages can quote outside content, so the result is left at the loop's
        // default: an untrusted tool result (m3-ux §3.1 names this exact marker).
        content: `${hits.length} ${hits.length === 1 ? "match" : "matches"} for "${query}":\n\n${lines.join("\n")}`,
      };
    },
  };
}
