// SPDX-License-Identifier: Apache-2.0
// The chat transport's protocol (M3-03, M3-23): what a tab may send, the v:1 frames both
// runtimes emit, and the file budgets every turn accounts. Pure functions shared by the Worker's
// Durable Object (`apps/worker/src/assistant.ts`) and the Node in-process assistant
// (`apps/node/src/assistant.ts`), so the two runtimes stay one port by construction.
import type { HarnessEvent, ModelMessage, ModelUsage, TurnFailure, TurnLimit } from "@opa/core";
import type { AttachmentRow } from "@opa/db/repository";
import { isId } from "@opa/db/repository";
import type { TurnState } from "@opa/harness-builtin";
import type { ChatModelError } from "./chat-model";

export const MAX_TEXT = 32_000;
export const MAX_ATTACHMENTS = 10;
/** How much of a text file one turn carries to the model; the file itself is kept whole in R2. */
export const MAX_ATTACHMENT_TEXT = 100_000;
/** How far a text file is read: enough bytes for `MAX_ATTACHMENT_TEXT` characters of any UTF-8. */
export const TEXT_READ_BYTES = MAX_ATTACHMENT_TEXT * 4;
/**
 * The bytes of files one turn hands the model. Images and PDFs go as base64 in one request, so
 * this bounds the host's memory and the upstream request whatever the conversation holds.
 */
export const TURN_FILE_BYTES = 16 * 1024 * 1024;
export const IMAGE_TOKENS = 2_500;
export const PDF_MAX_TOKENS = 100_000; // about 100 pages, the providers' usual page limit
/** Decided batches waiting for the running turn to end (M3-07 AC14, M3-09 AC4's FIFO). */
export const QUEUE_KEY = "approvals:queue";
/** How much of the original request a late approval's label quotes. */
export const LABEL_CHARS = 80;

export type Emit = <T extends HarnessEvent["type"]>(
  type: T,
  payload: Extract<HarnessEvent, { type: T }>["payload"],
) => void;

/** Anything that can take a frame for one tab: a DO connection or a Node socket wrapper. */
export interface FrameSender {
  send(data: string): void;
}

/** What `resumeBatch` did with a decided batch. */
export type ResumeResult = "resumed" | "waiting" | "queued" | "gone";

/** One progress event from a Workflow task (M3-12 AC8), as its driver numbers them. */
export interface TaskProgress {
  conversationId: string;
  turnId: string;
  taskId: string;
  seq: number;
  type: string;
  payload: unknown;
}

/** A turn's reply text in its saved state: one segment per model call that spoke. */
export const replySegments = (state: TurnState) =>
  state.messages.flatMap((m) => (m.role === "assistant" && m.content ? [m.content] : []));

/** The characters a request's messages carry, a text file's included, for its reservation. */
export const messageChars = (messages: readonly ModelMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      m.content.length +
      (m.role === "user"
        ? (m.attachments ?? []).reduce((n, f) => n + (f.text?.length ?? 0), 0)
        : 0),
    0,
  );

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export const pickUsage = (usage: ModelUsage): CallUsage => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedInputTokens: usage.cachedInputTokens,
});

/**
 * A saved `TurnState` back from D1, or `null` if it isn't one. The row is only ever written by
 * this host, so this is defense in depth: anything unexpected closes the turn instead of
 * running the loop over it.
 */
export function parseTurnState(json: string): TurnState | null {
  try {
    const s = JSON.parse(json) as Partial<TurnState> | null;
    if (!s || typeof s !== "object") return null;
    const counts = s.counts;
    const taint = s.taint;
    const usage = s.usage;
    if (!counts || typeof counts.calls !== "number" || typeof counts.tools !== "number")
      return null;
    if (!taint || (taint.taint !== "trusted" && taint.taint !== "untrusted")) return null;
    if (!Array.isArray(taint.sources)) return null;
    if (!usage || typeof usage.inputTokens !== "number") return null;
    if (!Array.isArray(s.messages)) return null;
    for (const m of s.messages) {
      if (!m || typeof m !== "object" || typeof m.content !== "string") return null;
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "tool" && m.role !== "system")
        return null;
    }
    const pending = s.pending;
    if (pending !== null) {
      if (!pending || typeof pending.batchId !== "string" || !Array.isArray(pending.items))
        return null;
    }
    return s as TurnState;
  } catch {
    return null;
  }
}

/**
 * What a tab may send: `chat.send`, with the chat's own model if it names one and any uploaded
 * files by ID, `turn.cancel`, `resume`, or the queue frames (M3-09 AC4) — `chat.steer`, text
 * only, joining its conversation's running turn, and `chat.dequeue`, taking a waiting send
 * back by the `messageId` its `turn.queued` carried. Anything else is ignored. The queue's
 * events (`turn.queued`, `turn.steered`, `turn.dequeued`) are the server's half of the 09b wire;
 * approvals still never ride the socket.
 */
export function parse(message: unknown) {
  if (typeof message !== "string") return null;
  try {
    const msg = JSON.parse(message) as Partial<Record<string, unknown>>;
    if (msg.type === "turn.cancel") return { type: "turn.cancel" } as const;
    if (msg.type === "resume") {
      const { conversationId, turnId, afterSeq } = msg;
      const at = typeof afterSeq === "number" && Number.isSafeInteger(afterSeq) && afterSeq >= 0;
      return isId(conversationId) && isId(turnId) && at
        ? ({ type: "resume", conversationId, turnId, afterSeq } as const)
        : null;
    }
    const conversationId = String(msg.conversationId);
    if (msg.type === "chat.steer" && typeof msg.text === "string" && isId(conversationId)) {
      // Text-only: files on a steer are ignored, and a steer for a conversation with no
      // running turn is heard as a send.
      return {
        type: "chat.steer",
        conversationId,
        text: msg.text,
        model: undefined,
        attachmentIds: [],
      } as const;
    }
    if (msg.type === "chat.dequeue" && isId(conversationId) && isId(msg.messageId)) {
      return { type: "chat.dequeue", conversationId, messageId: msg.messageId } as const;
    }
    if (msg.type === "chat.send" && typeof msg.text === "string") {
      const { provider, model } = (msg.model ?? {}) as Partial<Record<string, unknown>>;
      const own =
        typeof provider === "string" && typeof model === "string" && provider && model
          ? { provider, model }
          : undefined;
      const ids = Array.isArray(msg.attachmentIds) ? msg.attachmentIds.filter(isId) : [];
      return {
        type: "chat.send",
        conversationId,
        text: msg.text,
        model: own,
        attachmentIds: [...new Set(ids)].slice(0, MAX_ATTACHMENTS),
      } as const;
    }
  } catch {}
  return null;
}

/** m3-ux §3.2, for a file the chosen model can't read. The file is kept with the message. */
export const UNREAD = {
  image: "This model can't see images. I'll keep the file in Outputs, but it won't read it.",
  pdf: "This model can't read PDFs. I'll keep the file in Outputs, but it won't read it.",
} as const;

/** Encoded in slices a multiple of 3 bytes long, so no binary string of the whole file is built. */
export function base64(bytes: Uint8Array): string {
  const slices: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x6000)
    slices.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 0x6000))));
  return slices.join("");
}

/** Up to `limit` bytes from the start of a stream, and whether it held more; the rest is not read. */
export async function readPrefix(body: ReadableStream<Uint8Array>, limit: number) {
  const bytes = new Uint8Array(limit);
  let filled = 0;
  let more = false;
  const reader = body.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    const take = Math.min(next.value.byteLength, limit - filled);
    bytes.set(next.value.subarray(0, take), filled);
    filled += take;
    if (take < next.value.byteLength || filled === limit) {
      more = take < next.value.byteLength || !(await reader.read()).done;
      break;
    }
  }
  await reader.cancel().catch(() => {});
  return { bytes: bytes.subarray(0, filled), more };
}

/** What a file costs the turn's byte budget: a text file only as far as it is read. */
export const modelBytes = (row: AttachmentRow) =>
  row.kind === "text" ? Math.min(row.sizeBytes, TEXT_READ_BYTES) : row.sizeBytes;

/**
 * A file's input tokens for the spend reservation; its text is counted as characters. The
 * providers scale an image down to a bounded size, so it costs at most a few thousand tokens; a
 * PDF is read page by page, so it is counted by size up to the providers' page limit.
 */
export const fileTokenEstimate = (row: AttachmentRow) =>
  row.kind === "image"
    ? IMAGE_TOKENS
    : row.kind === "pdf"
      ? Math.min(PDF_MAX_TOKENS, Math.ceil(row.sizeBytes / 4))
      : 0;

/**
 * A history's files for a later call's spend reservation. Text rides in `chars`, as in the first
 * call; a PDF is measured from its base64, which decodes to about three quarters of its length.
 */
export const messageFileTokens = (messages: readonly ModelMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      (m.role === "user"
        ? (m.attachments ?? []).reduce(
            (n, f) =>
              n +
              (f.kind === "image"
                ? IMAGE_TOKENS
                : f.kind === "pdf"
                  ? Math.min(PDF_MAX_TOKENS, Math.ceil(((f.data?.length ?? 0) * 3) / 16))
                  : 0),
            0,
          )
        : 0),
    0,
  );

export const MODEL_ERRORS: Partial<Record<ChatModelError, string>> = {
  no_model: "Pick a model in Settings first.",
  key_required: "Enter your model key again in Settings.",
  vault_reset_required:
    "Your saved keys can't be opened. Reset them in Settings, then enter your key again.",
};

/**
 * Fails a send for the tab that made it only. No turn started, so it has no turn ID, and `seq` 0
 * keeps it outside the sequence of a turn the tab may be receiving.
 */
export function reject(
  connection: FrameSender,
  sessionId: string,
  message: string,
  reason?: TurnLimit,
  code?: TurnFailure,
) {
  const event: HarnessEvent = {
    v: 1,
    seq: 0,
    sessionId,
    turnId: "",
    type: "turn.failed",
    payload: { message, ...(reason && { reason }), ...(code && { code }) },
  };
  connection.send(JSON.stringify(event));
}
