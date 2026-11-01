// SPDX-License-Identifier: Apache-2.0
// Attaching files (M3-10): what the composer may offer comes from `GET /api/attachments/config`
// (the cap, the type list, what the chosen model reads), and each pick is uploaded straight away
// so Send only ever waits on files still in flight. Copy is m3-ux §3.2, with the cap and the
// file's extension interpolated from that config.

export type AttachmentKind = "image" | "pdf" | "text";

export interface AttachmentType {
  ext: string;
  mediaType: string;
  kind: AttachmentKind;
}

export interface AttachmentConfig {
  maxBytes: number;
  accept: string;
  types: AttachmentType[];
  /** What the model for this chat reads; `null` until a model is set up. */
  model: { imageInput: boolean; pdfInput: boolean } | null;
}

/** The server's defaults (M3-10 AC1), used until the config loads; the server still decides. */
export const DEFAULT_CONFIG: AttachmentConfig = {
  maxBytes: 10 * 1024 * 1024,
  accept: ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json",
  types: [
    { ext: "png", mediaType: "image/png", kind: "image" },
    { ext: "jpg", mediaType: "image/jpeg", kind: "image" },
    { ext: "jpeg", mediaType: "image/jpeg", kind: "image" },
    { ext: "webp", mediaType: "image/webp", kind: "image" },
    { ext: "gif", mediaType: "image/gif", kind: "image" },
    { ext: "pdf", mediaType: "application/pdf", kind: "pdf" },
    { ext: "txt", mediaType: "text/plain", kind: "text" },
    { ext: "md", mediaType: "text/markdown", kind: "text" },
    { ext: "csv", mediaType: "text/csv", kind: "text" },
    { ext: "json", mediaType: "application/json", kind: "text" },
  ],
  model: null,
};

/** As many files as one send may carry; the Assistant refuses more. */
export const MAX_FILES = 10;

/** A file the server has stored: its sniffed type, which may differ from what the name claimed. */
export interface UploadedFile {
  id: string;
  name: string;
  mediaType: string;
  kind: AttachmentKind;
  sizeBytes: number;
}

/** One chip above the composer, from pick to sent. `file` is kept so a failed upload can retry. */
export interface PendingAttachment {
  key: string;
  file: File | null;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  progress: number;
  uploaded?: UploadedFile | undefined;
  error?: string | undefined;
  /** A too-large or unreadable file would fail again; only a failed upload offers Retry. */
  retryable?: boolean | undefined;
}

export async function fetchAttachmentConfig(model?: {
  provider: string;
  model: string;
}): Promise<AttachmentConfig> {
  // A chat's own model by name; without one, the Chat role's.
  const query = model ? `?${new URLSearchParams(model)}` : "";
  const res = await fetch(`/api/attachments/config${query}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`attachments config: ${res.status}`);
  return res.json();
}

export class UploadFailure extends Error {
  constructor(
    readonly code: string,
    readonly maxBytes?: number,
  ) {
    super(code);
  }
}

/**
 * Uploads one file as the request body itself (the server streams it on to storage), reporting
 * progress. `XMLHttpRequest` because `fetch` still can't report upload progress everywhere.
 */
export function uploadAttachment(
  file: File,
  onProgress: (fraction: number) => void,
): { promise: Promise<UploadedFile>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedFile>((resolve, reject) => {
    xhr.open("POST", "/api/attachments");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: string; maxBytes?: number } & Partial<UploadedFile> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 201 && body.id) return resolve(body as UploadedFile);
      reject(new UploadFailure(body.error ?? "failed", body.maxBytes));
    };
    xhr.onerror = () => reject(new UploadFailure("failed"));
    xhr.onabort = () => reject(new UploadFailure("aborted"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export async function deleteAttachment(id: string): Promise<void> {
  await fetch(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** "10 MB", "340 KB", "12 B": whole numbers where they land, one decimal where they don't. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 ? `${value}` : `${Math.round(value * 10) / 10}`;
  return `${shown} ${units[unit]}`;
}

/** The kind a name claims, from the config's type list; the sniffed kind replaces it on upload. */
export function kindOfName(name: string, config: AttachmentConfig): AttachmentKind | null {
  const ext = name.toLowerCase().split(".").at(-1) ?? "";
  if (!name.includes(".")) return null;
  return config.types.find((t) => t.ext === ext)?.kind ?? null;
}

export const tooLargeCopy = (maxBytes: number) => `Too large (max ${formatBytes(maxBytes)})`;

export function unsupportedCopy(name: string): string {
  const ext = name.includes(".") ? `.${name.toLowerCase().split(".").at(-1)}` : "";
  const what = ext && ext.length > 1 ? `${ext} files` : "this file";
  return `I can't read ${what}. I can read images, PDFs and text files.`;
}

/** m3-ux §3.2: what to say, before and after sending, about a file the chosen model won't read. */
export function cannotReadCopy(kind: AttachmentKind): string {
  return kind === "image"
    ? "This model can't see images. I'll keep the file in Outputs, but it won't read it."
    : "This model can't read PDFs. I'll keep the file in Outputs, but it won't read it.";
}

/** Why this pick can't be attached, or `null` when it can. The server checks again, by its bytes. */
export function pickProblem(
  file: Pick<File, "name" | "size">,
  config: AttachmentConfig,
): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > config.maxBytes) return tooLargeCopy(config.maxBytes);
  if (!kindOfName(file.name, config)) return unsupportedCopy(file.name);
  return null;
}

/** The chip error for a refused or failed upload, in the same words as a refused pick. */
export function uploadProblem(
  failure: UploadFailure,
  name: string,
  config: AttachmentConfig,
): string {
  switch (failure.code) {
    case "too_large":
      return tooLargeCopy(failure.maxBytes ?? config.maxBytes);
    case "unsupported_type":
      return unsupportedCopy(name);
    case "empty_file":
      return "That file is empty.";
    default:
      return "Upload failed.";
  }
}

/** Only a failure in sending the file can succeed on a second try. */
export const isRetryable = (failure: UploadFailure) => failure.code === "failed";

/**
 * Whether the model will be given this file, as far as this tab can tell: text goes to any
 * model, the rest only where the flags allow. The server records what really happened.
 */
export function willRead(kind: AttachmentKind, model: AttachmentConfig["model"]): boolean | null {
  if (kind === "text") return true;
  if (!model) return null;
  return kind === "image" ? model.imageInput : model.pdfInput;
}

/** The kinds among `kinds` the chosen model is known not to read, in the order they first appear. */
export function unreadKinds(
  kinds: readonly AttachmentKind[],
  model: AttachmentConfig["model"],
): AttachmentKind[] {
  const seen = new Set<AttachmentKind>();
  for (const kind of kinds) if (willRead(kind, model) === false) seen.add(kind);
  return [...seen];
}
