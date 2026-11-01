// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { FileTrigger, Form, ProgressBar, TextArea } from "react-aria-components";
import { Button } from "../ui";
import {
  type AttachmentConfig,
  cannotReadCopy,
  formatBytes,
  kindOfName,
  type PendingAttachment,
  unreadKinds,
} from "./attachments";

interface Props {
  busy: boolean;
  /** The draft belongs to the conversation, so the app holds it. */
  text: string;
  setText: (text: string) => void;
  onSend: (text: string) => boolean;
  onStop: () => void;
  /** What may be attached in this chat, and what its model reads (M3-10 AC1–2). */
  config: AttachmentConfig;
  files: PendingAttachment[];
  onPick: (files: File[]) => void;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  /** The context chip above the text area (m3-ux §3.2); absent until settings load. */
  chip?: ReactNode | undefined;
  /** With no model set up there is nothing to send to: Send opens Settings › Models instead. */
  onNoModel?: (() => void) | undefined;
}

/**
 * Enter sends and Shift+Enter starts a new line. While a reply streams, Send becomes Stop.
 * `onSend` returns false when it did not send, so the draft stays. While a file is still
 * uploading, Send reads "Sending after upload…" and the send goes once the uploads finish
 * (m3-ux §3.2).
 */
export function Composer({
  busy,
  text,
  setText,
  onSend,
  onStop,
  config,
  files,
  onPick,
  onRemove,
  onRetry,
  chip,
  onNoModel,
}: Props) {
  const submit = () => {
    if (onNoModel) return onNoModel();
    if (onSend(text)) setText("");
  };
  const uploading = files.some((f) => f.status === "uploading");
  const unread = unreadKinds(
    files.flatMap((f) => {
      const kind = f.uploaded?.kind ?? kindOfName(f.name, config);
      return kind ? [kind] : [];
    }),
    config.model,
  );

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) onStop();
        else submit();
      }}
      className="border-t border-border bg-surface"
    >
      <div className="mx-auto flex max-w-[720px] flex-col gap-2 p-3">
        {files.length > 0 && (
          <ul aria-label="Attached files" className="flex flex-wrap gap-2">
            {files.map((f) => (
              <Chip key={f.key} file={f} onRemove={onRemove} onRetry={onRetry} />
            ))}
          </ul>
        )}
        {unread.map((kind) => (
          <p key={kind} className="text-sm text-text-muted">
            {cannotReadCopy(kind)}
          </p>
        ))}
        {chip}
        <div className="flex items-end gap-2">
          <FileTrigger
            allowsMultiple
            acceptedFileTypes={config.accept.split(",")}
            onSelect={(picked) => picked && onPick([...picked])}
          >
            <Button>Attach</Button>
          </FileTrigger>
          <TextArea
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={1}
            placeholder="Message your assistant"
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              if (!busy) submit();
            }}
            className="field-sizing-content block max-h-52 min-h-11 flex-1 resize-none rounded-xl border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted"
          />
          <Button type="submit" variant="primary">
            {busy ? "Stop" : uploading ? "Sending after upload…" : "Send"}
          </Button>
        </div>
      </div>
    </Form>
  );
}

function Chip({
  file: f,
  onRemove,
  onRetry,
}: {
  file: PendingAttachment;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}) {
  const failed = f.status === "error";
  return (
    <li
      className={`flex min-h-11 max-w-full items-center gap-2 rounded-xl border px-3 py-1 text-sm ${
        failed ? "border-danger" : "border-border-strong bg-surface-raised"
      }`}
    >
      <span className="min-w-0">
        <span className="block max-w-48 truncate font-medium">{f.name}</span>
        {failed ? (
          <span role="alert" className="block text-danger">
            {f.error}
          </span>
        ) : (
          <span className="block text-text-muted">{formatBytes(f.size)}</span>
        )}
        {f.status === "uploading" && (
          <ProgressBar
            value={Math.round(f.progress * 100)}
            aria-label={`Uploading ${f.name}`}
            className="mt-1 block"
          >
            {({ percentage }) => (
              <span className="block h-1 w-32 overflow-hidden rounded bg-border">
                <span className="block h-1 bg-accent" style={{ width: `${percentage}%` }} />
              </span>
            )}
          </ProgressBar>
        )}
      </span>
      {failed && f.retryable && (
        <Button variant="quiet" className="shrink-0" onPress={() => onRetry(f.key)}>
          Retry
        </Button>
      )}
      <Button
        variant="quiet"
        aria-label={`Remove ${f.name}`}
        onPress={() => onRemove(f.key)}
        className="min-w-11 shrink-0 justify-center"
      >
        <span aria-hidden="true">✕</span>
      </Button>
    </li>
  );
}
