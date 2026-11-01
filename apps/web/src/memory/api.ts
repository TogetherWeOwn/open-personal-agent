// SPDX-License-Identifier: Apache-2.0
// The Memory screen's calls (M3-15) and the shapes the server sends. A note is what the
// assistant remembers.
import type { Trust } from "../ui";

export interface Note {
  id: string;
  kind: "fact" | "instruction";
  text: string;
  trust: Trust;
  /** `update` or `merge` means it has earlier versions; on a proposal, what it would do. */
  op: "create" | "update" | "merge" | "delete";
  source: "memory_screen" | "chat" | "web" | "file" | "tool" | "system";
  sourceRef: string | null;
  sourceExcerpt: string | null;
  conversation: { id: string; title: string | null } | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export async function memoryApi<T>(path = "", method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/memory${path}`, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const listNotes = (q = "") =>
  memoryApi<{ memories: Note[] }>(q ? `?q=${encodeURIComponent(q)}` : "").then((r) => r.memories);

export const addNote = (text: string) =>
  memoryApi<{ memory: Note }>("", "POST", { text }).then((r) => r.memory);

/** Saves an edit as a new version; the server supersedes the old one. */
export const editNote = (id: string, text: string) =>
  memoryApi<{ memory: Note }>(`/${id}`, "PUT", { text }).then((r) => r.memory);

export const noteVersions = (id: string) =>
  memoryApi<{ versions: Note[] }>(`/${id}/versions`).then((r) => r.versions);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 h ago", "3 days ago"; a date once it's older than a week. */
export function ago(ts: number, now = Date.now()) {
  const span = Math.max(0, now - ts);
  if (span < MINUTE) return "just now";
  if (span < HOUR) return `${Math.floor(span / MINUTE)} min ago`;
  if (span < DAY) return `${Math.floor(span / HOUR)} h ago`;
  if (span < 7 * DAY) {
    const days = Math.floor(span / DAY);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  return `on ${new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" })}`;
}

/** Where a note came from, in words. */
export function sourceLabel(note: Note) {
  const from = {
    memory_screen: "You added this here",
    chat: "From a chat",
    web: "From a web page",
    file: "From a file",
    tool: "From a tool",
    system: "Built in",
  }[note.source];
  return note.conversation?.title && note.source !== "memory_screen"
    ? `${from}: ${note.conversation.title}`
    : from;
}

const ERRORS: Record<string, string> = {
  not_found: "That note changed or was deleted meanwhile. The list has been refreshed.",
  built_in: "Built-in notes can be deleted but not changed.",
  invalid_text: "Write the note in 2,000 characters or fewer.",
};
export const memoryError = (e: unknown) =>
  ERRORS[(e as Error).message] ?? "That didn't work. Try again.";
