// SPDX-License-Identifier: Apache-2.0
// Attached files (M3-10 AC1): the upload body streams through to R2 under `u/{userId}/`, the
// type is sniffed here from the first bytes (the client's `Content-Type` and the name's
// extension are never trusted for a binary type), and a file is served back only to its owner,
// sandboxed or as a download (`userContent`, ADR 0010 D5).
import { createRepository, isId } from "@opa/db/repository";
import { Hono } from "hono";
import { type ModelPick, resolveChatModel } from "./chat-model";
import type { AppEnv, Env } from "./env";
import { userContent } from "./security";

export type AttachmentKind = "image" | "pdf" | "text";

/** The file types an upload may be, by name extension (M3-10 AC1). Binary types must also sniff. */
export const ATTACHMENT_TYPES: readonly {
  ext: string;
  mediaType: string;
  kind: AttachmentKind;
}[] = [
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
];

const BY_MEDIA_TYPE = new Map(ATTACHMENT_TYPES.map((t) => [t.mediaType, t]));
const TEXT_BY_EXT = new Map(
  ATTACHMENT_TYPES.filter((t) => t.kind === "text").map((t) => [t.ext, t]),
);

/** 10 MB by default (M3-10 AC1); a deployment may set `OPA_ATTACHMENT_MAX_BYTES`. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_LIMIT = 100 * 1024 * 1024;

/** The per-file cap in force: the configured value when it parses to a sane size, else the default. */
export function attachmentMaxBytes(env: Env): number {
  const set = Number(env.OPA_ATTACHMENT_MAX_BYTES);
  return Number.isInteger(set) && set > 0 ? Math.min(set, MAX_LIMIT) : DEFAULT_ATTACHMENT_MAX_BYTES;
}

const startsWith = (bytes: Uint8Array, head: readonly number[]) =>
  head.every((b, i) => bytes[i] === b);
const ascii = (text: string) => [...text].map((ch) => ch.charCodeAt(0));

/** A valid start of a multi-byte character the window may have cut short (lead + continuations). */
function isCutCharacter(tail: Uint8Array): boolean {
  const lead = tail[0] ?? 0;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
  return need > tail.length && [...tail.subarray(1)].every((b) => b >= 0x80 && b < 0xc0);
}

/** Decodes as UTF-8, allowing the sniff window to have cut the last character in two. */
function decodesUtf8(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    decoder.decode(bytes);
    return true;
  } catch {}
  for (let trim = 1; trim <= 3 && trim < bytes.length; trim++) {
    if (!isCutCharacter(bytes.subarray(bytes.length - trim))) continue;
    try {
      decoder.decode(bytes.subarray(0, bytes.length - trim));
      return true;
    } catch {}
  }
  return false;
}

/** No NUL or stray control bytes (tabs and lines aside). */
function noControlBytes(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if (b === 0x7f || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d))
      return false;
  }
  return true;
}

/** Text, conservatively: a UTF-8 decode with no NUL or stray control bytes (tabs and lines aside). */
function looksText(bytes: Uint8Array): boolean {
  return noControlBytes(bytes) && decodesUtf8(bytes);
}

/**
 * Checks a text file past its sniff window, chunk by chunk as it streams: the same rule as
 * `looksText`, over the whole file. `done` checks no character was left cut at the end.
 */
function textChecker() {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const ok = (run: () => unknown) => {
    try {
      run();
      return true;
    } catch {
      return false;
    }
  };
  return {
    chunk: (bytes: Uint8Array) =>
      noControlBytes(bytes) && ok(() => decoder.decode(bytes, { stream: true })),
    done: () => ok(() => decoder.decode()),
  };
}

/**
 * The type a file is, from its first bytes — never from what the client claimed. An image or PDF
 * signature decides outright, whatever the name says. Text has no signature to tell TXT from CSV,
 * so there the name's extension picks among the text types and the bytes must still look like
 * text (and like JSON, for `.json`). Anything else is not a type we take.
 */
export function sniffAttachment(
  first: Uint8Array,
  name: string,
): { mediaType: string; kind: AttachmentKind } | null {
  const bySignature = (mediaType: string) => {
    const t = BY_MEDIA_TYPE.get(mediaType);
    return t ? { mediaType: t.mediaType, kind: t.kind } : null;
  };
  if (startsWith(first, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return bySignature("image/png");
  if (startsWith(first, [0xff, 0xd8, 0xff])) return bySignature("image/jpeg");
  if (startsWith(first, ascii("GIF87a")) || startsWith(first, ascii("GIF89a")))
    return bySignature("image/gif");
  if (startsWith(first, ascii("RIFF")) && startsWith(first.subarray(8), ascii("WEBP")))
    return bySignature("image/webp");
  if (startsWith(first, ascii("%PDF-"))) return bySignature("application/pdf");

  const ext = name.toLowerCase().split(".").at(-1) ?? "";
  const text = TEXT_BY_EXT.get(ext);
  if (!text || !looksText(first)) return null;
  if (text.mediaType === "application/json") {
    const head = new TextDecoder()
      .decode(first)
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (head[0] !== "{" && head[0] !== "[") return null;
  }
  return { mediaType: text.mediaType, kind: "text" };
}

/** The display name from the `x-file-name` header (percent-encoded by the client): no path, bounded. */
export function fileName(header: string | undefined): string {
  let name = "file";
  try {
    name = decodeURIComponent(header ?? "");
  } catch {}
  name = name
    .replace(/.*[/\\]/, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return name || "file";
}

/** How many first bytes decide the type. A signature needs 12; text gets a fuller look. */
const SNIFF_BYTES = 512;

export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413 | 415 | 429,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The same MIME and whole-text checks for session attachments and computer Outputs. */
export async function readAttachment(
  body: ReadableStream<Uint8Array> | null,
  name: string,
  maxBytes: number,
  charge: (bytes: number) => Promise<void> = async () => {},
) {
  if (!body) throw new UploadError(400, "empty_file");
  const reader = body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  let failure: unknown;
  const take = async () => {
    const result = await reader.read();
    if (!result.done) {
      size += result.value.byteLength;
      if (size > maxBytes) throw new UploadError(413, "too_large");
      await charge(result.value.byteLength);
    }
    return result;
  };
  try {
    while (size < SNIFF_BYTES && !ended) {
      const result = await take();
      ended = result.done;
      if (!result.done) head.push(result.value);
    }
    if (!size) throw new UploadError(400, "empty_file");
    const first = new Uint8Array(Math.min(size, SNIFF_BYTES));
    let offset = 0;
    for (const chunk of head) {
      const part = chunk.subarray(0, first.length - offset);
      first.set(part, offset);
      offset += part.length;
      if (offset === first.length) break;
    }
    const sniffed = sniffAttachment(first, name);
    if (!sniffed) throw new UploadError(415, "unsupported_type");
    const text = sniffed.kind === "text" ? textChecker() : null;
    let next = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const result =
              next < head.length
                ? { done: false, value: head[next++] as Uint8Array }
                : await take();
            if (result.done) {
              if (text && !text.done()) throw new UploadError(415, "unsupported_type");
              controller.close();
            } else {
              if (text && !text.chunk(result.value)) throw new UploadError(415, "unsupported_type");
              controller.enqueue(result.value);
            }
          } catch (error) {
            failure = error;
            await reader.cancel().catch(() => {});
            controller.error(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    return { stream, name, ...sniffed, sizeBytes: () => size, failure: () => failure };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

export const attachmentRoutes = new Hono<AppEnv>();

/** What the composer needs before a pick: the cap, the picker's `accept`, and what the model reads. */
attachmentRoutes.get("/config", async (c) => {
  // The chat's own model by name, as its chip shows it before a switch is saved; or a saved
  // chat's; or the Chat role's. A provider that isn't the user's names no model.
  const { provider, model, conversationId } = c.req.query();
  const pick: ModelPick = provider
    ? { provider, ...(model ? { model } : {}) }
    : conversationId && isId(conversationId)
      ? { conversationId }
      : { role: "chat" };
  const picked = await resolveChatModel(c.env, c.var.session.scope, "attachments", pick).catch(
    () => null,
  );
  const caps = picked && !("error" in picked) ? picked.provider.capabilities(picked.model) : null;
  c.header("Cache-Control", "no-store");
  return c.json({
    maxBytes: attachmentMaxBytes(c.env),
    accept: ATTACHMENT_TYPES.map((t) => `.${t.ext}`).join(","),
    types: ATTACHMENT_TYPES,
    model: caps ? { imageInput: caps.imageInput === true, pdfInput: caps.pdfInput === true } : null,
  });
});

/**
 * Streams one file to R2. The body is the file itself — no multipart, whose parsing would buffer
 * it — with the name in `x-file-name`. Only the sniff window is ever held in memory; the rest
 * passes through a counter that stops the upload the moment it passes the cap.
 */
attachmentRoutes.post("/", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const maxBytes = attachmentMaxBytes(c.env);
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes)
    return c.json({ error: "too_large", maxBytes }, 413);
  const id = crypto.randomUUID();
  let upload: Awaited<ReturnType<typeof readAttachment>> | undefined;
  try {
    upload = await readAttachment(c.req.raw.body, fileName(c.req.header("x-file-name")), maxBytes);
    await user.attachments.putObject(
      id,
      upload.stream,
      upload.mediaType,
      Number.isFinite(declared) ? declared : undefined,
    );
    const row = {
      id,
      name: upload.name,
      mediaType: upload.mediaType,
      kind: upload.kind,
      sizeBytes: upload.sizeBytes(),
    };
    await user.attachments.create(row);
    c.header("Cache-Control", "no-store");
    return c.json(row, 201);
  } catch (error) {
    await user.attachments.removeObject(id).catch(() => {});
    const failure = upload?.failure() ?? error;
    if (failure instanceof UploadError)
      return c.json(
        { error: failure.code, ...(failure.status === 413 ? { maxBytes } : {}) },
        failure.status,
      );
    throw error;
  }
});

/** The file itself, to its owner only: previewable types inline behind the sandbox, the rest a download. */
attachmentRoutes.get("/:id", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  const row = await user.attachments.get(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const object = await user.attachments.getObject(row.id);
  if (!object?.body) return c.json({ error: "not_found" }, 404);
  return userContent(object.body, row.mediaType, row.name);
});

attachmentRoutes.delete("/:id", async (c) => {
  const user = createRepository(c.env).forUser(c.var.session.scope);
  if (!(await user.attachments.remove(c.req.param("id"))))
    return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
