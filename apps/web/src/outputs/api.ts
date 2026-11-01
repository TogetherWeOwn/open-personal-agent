// SPDX-License-Identifier: Apache-2.0
// Outputs data (M3-11): the `/api/artifacts` reads.

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

/** `after` is the last file already shown: the next page starts just past its time and ID. */
export async function listArtifacts(conversationId?: string, after?: Artifact) {
  const query = new URLSearchParams();
  if (conversationId) query.set("conversationId", conversationId);
  if (after) {
    query.set("before", String(after.createdAt));
    query.set("beforeId", after.id);
  }
  const res = await fetch(`/api/artifacts${query.size ? `?${query}` : ""}`);
  if (!res.ok) throw new Error("load_failed");
  return ((await res.json()) as { artifacts: Artifact[] }).artifacts;
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
