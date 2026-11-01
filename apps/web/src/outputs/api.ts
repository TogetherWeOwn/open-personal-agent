// SPDX-License-Identifier: Apache-2.0
// Outputs data (M3-11): the `/api/artifacts` reads, and Delete with Undo. A delete waits out the
// Undo window before it is sent, so Undo never has to restore anything; leaving the page sends
// whatever is still waiting.
import { useSyncExternalStore } from "react";

/** A row of `GET /api/artifacts`: the file and the run that wrote it. */
export interface Artifact {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  conversationId: string | null;
  conversationTitle: string | null;
  taskId: string | null;
  createdAt: number;
}

/** What `GET /api/artifacts` returns in one read; a full page means older files may follow. */
export const PAGE = 100;

export const contentUrl = (id: string, download = false) =>
  `/api/artifacts/${encodeURIComponent(id)}/content${download ? "?download=1" : ""}`;

export async function listArtifacts(conversationId?: string, before?: number) {
  const query = new URLSearchParams();
  if (conversationId) query.set("conversationId", conversationId);
  if (before !== undefined) query.set("before", String(before));
  const res = await fetch(`/api/artifacts${query.size ? `?${query}` : ""}`);
  if (!res.ok) throw new Error("load_failed");
  return ((await res.json()) as { artifacts: Artifact[] }).artifacts;
}

/** The file's row, or `null` when it doesn't exist (or isn't this user's). */
export async function getArtifact(id: string): Promise<Artifact | null> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("application/json")) throw new Error("load_failed");
  return res.json();
}

/** How long Undo stays offered (m3-ux: an Undo toast lasts 10 s). */
export const UNDO_MS = 10_000;

interface Pending {
  artifact: Artifact;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let failed: Artifact[] = [];
let snapshot: { pending: Artifact[]; failed: Artifact[] } = { pending: [], failed: [] };
const listeners = new Set<() => void>();
const changed = () => {
  snapshot = { pending: [...pending.values()].map((p) => p.artifact), failed };
  for (const listener of listeners) listener();
};

function send(id: string, keepalive = false) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  fetch(`/api/artifacts/${encodeURIComponent(id)}`, { method: "DELETE", keepalive })
    .then((res) => {
      // Already gone counts as deleted.
      if (!res.ok && res.status !== 404) throw new Error("delete_failed");
    })
    .catch(() => {
      failed = [...failed, entry.artifact];
      changed();
    });
  changed();
}

/** Hides the file now and deletes it once the Undo window closes. */
export function deleteLater(artifact: Artifact) {
  if (pending.has(artifact.id)) return;
  failed = failed.filter((f) => f.id !== artifact.id);
  pending.set(artifact.id, { artifact, timer: setTimeout(() => send(artifact.id), UNDO_MS) });
  changed();
}

export function undoDelete(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  changed();
}

export function dismissFailure(id: string) {
  failed = failed.filter((f) => f.id !== id);
  changed();
}

window.addEventListener("pagehide", () => {
  for (const id of [...pending.keys()]) send(id, true);
});

/** The deletes waiting out their Undo window, and the ones the server refused. */
export function useDeletes() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

const size = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${size.format(bytes / 1024)} KB`;
  return `${size.format(bytes / (1024 * 1024))} MB`;
}

const TYPE_NAMES: Record<string, string> = {
  "text/markdown": "Markdown",
  "text/plain": "Text",
  "text/html": "Web page",
  "text/csv": "Spreadsheet",
  "application/json": "JSON",
  "application/pdf": "PDF",
};

export function typeName(mediaType: string) {
  if (mediaType.startsWith("image/")) return "Image";
  return TYPE_NAMES[mediaType] ?? "File";
}

/** How the preview shows a type; `none` gets the download card. */
export function previewKind(mediaType: string): "markdown" | "text" | "html" | "image" | "none" {
  if (mediaType === "text/markdown") return "markdown";
  if (mediaType === "text/html") return "html";
  if (/^image\/(?:png|jpeg|gif|webp)$/.test(mediaType)) return "image";
  if (mediaType === "text/plain" || mediaType === "text/csv" || mediaType === "application/json")
    return "text";
  return "none";
}
