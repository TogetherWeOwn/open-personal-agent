// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { Form, TextArea } from "react-aria-components";
import { Button } from "../ui";

interface Props {
  busy: boolean;
  /** The draft belongs to the conversation, so the app holds it. */
  text: string;
  setText: (text: string) => void;
  onSend: (text: string) => boolean;
  onStop: () => void;
  /** The context chip above the text area (m3-ux §3.2); absent until settings load. */
  chip?: ReactNode | undefined;
  /** With no model set up there is nothing to send to: Send opens Settings › Models instead. */
  onNoModel?: (() => void) | undefined;
}

/** Enter sends and Shift+Enter starts a new line. While a reply streams, Send becomes Stop.
 * `onSend` returns false when it did not send, so the draft stays. */
export function Composer({ busy, text, setText, onSend, onStop, chip, onNoModel }: Props) {
  const submit = () => {
    if (onNoModel) return onNoModel();
    if (onSend(text)) setText("");
  };

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
        {chip}
        <div className="flex items-end gap-2">
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
            {busy ? "Stop" : "Send"}
          </Button>
        </div>
      </div>
    </Form>
  );
}
