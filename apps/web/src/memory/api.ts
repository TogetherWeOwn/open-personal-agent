// SPDX-License-Identifier: Apache-2.0
// The Memory screen's calls (M3-15) and the shapes the server sends. A note is what the
// assistant remembers; a proposal is a note waiting for the user, never applied on its own.
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
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

export interface Proposal extends Note {
  /** The current notes it would replace or delete; empty for a new fact. */
  targets: Note[];
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

export const addNote = (text: string, kind: Note["kind"] = "fact") =>
  memoryApi<{ memory: Note }>("", "POST", { text, kind }).then((r) => r.memory);

/** The server returns at most this many search matches. */
export const SEARCH_LIMIT = 100;

/** Saves an edit as a new version; the server supersedes the old one. */
export const editNote = (id: string, text: string) =>
  memoryApi<{ memory: Note }>(`/${id}`, "PUT", { text }).then((r) => r.memory);

export const noteVersions = (id: string) =>
  memoryApi<{ versions: Note[] }>(`/${id}/versions`).then((r) => r.versions);

export const listProposals = () =>
  memoryApi<{ expired: number; proposals: Proposal[] }>("/proposals");

export type Decision = "accept" | "keep-both" | "reject";

export const decide = (id: string, decision: Decision) =>
  memoryApi<{ memory: Note } | undefined>(`/proposals/${id}/${decision}`, "POST");

/** The account step-up: one passkey prompt that covers this session for 5 minutes. */
async function stepUp(): Promise<void> {
  const post = (path: string, body: unknown) =>
    fetch(`/api/auth/step-up/session${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const res = await post("/options", {});
  const { options } = (await res.json().catch(() => ({}))) as {
    options?: PublicKeyCredentialRequestOptionsJSON;
  };
  if (!res.ok || !options) throw new Error("step_up_failed");
  const credential = await startAuthentication({ optionsJSON: options });
  if (!(await post("", { credential })).ok) throw new Error("step_up_failed");
}

/**
 * Saves the `opa-memory-export/v1` file. Export is an account action, so the server asks for a
 * passkey step-up first; the prompt shows once, then the download runs.
 */
export async function downloadExport(stepped = false): Promise<void> {
  const res = await fetch("/api/memory/export");
  if (res.status === 403 && !stepped) {
    await stepUp();
    return downloadExport(true);
  }
  if (!res.ok) throw new Error("export_failed");
  const name =
    /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
    "memory.opa-memory.json";
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Why the download didn't start, in words; a dismissed passkey prompt is the usual reason. */
export const exportError = (e: unknown) =>
  (e as Error).name === "NotAllowedError" || (e as Error).message === "step_up_failed"
    ? "Your passkey wasn't confirmed, so nothing was downloaded. Try again."
    : "I couldn't download your notes. Check your connection and try again.";

/** Settings › Memory's "Learn from our chats" (M3-15 AC5). */
export async function learnSetting(value?: boolean): Promise<boolean> {
  const res = await fetch("/api/settings/memory", {
    method: value === undefined ? "GET" : "PUT",
    ...(value === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ learnFromChats: value }),
        }),
  });
  if (!res.ok) throw new Error(String(res.status));
  return ((await res.json()) as { learnFromChats: boolean }).learnFromChats;
}

/** "Expires in 9 days"; "Expires today" in the last 24 hours. */
export function expiresIn(ts: number | null, now = Date.now()) {
  const days = Math.floor(((ts ?? now) - now) / 86_400_000);
  return days < 1 ? "Expires today" : `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** The line every delete carries (M3-15 AC3): D1 Time Travel keeps deleted data 30 days. */
export const BACKUP_LINE = "A backup copy is kept for 30 days, then it's gone.";

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
