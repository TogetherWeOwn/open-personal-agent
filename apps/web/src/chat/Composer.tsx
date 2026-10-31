// SPDX-License-Identifier: Apache-2.0
import { Button, Form, TextArea } from "react-aria-components";

interface Props {
  busy: boolean;
  /** The draft belongs to the conversation, so the app holds it. */
  text: string;
  setText: (text: string) => void;
  onSend: (text: string) => boolean;
  onStop: () => void;
}

/** Enter sends and Shift+Enter starts a new line. While a reply streams, Send becomes Stop.
 * `onSend` returns false when it did not send, so the draft stays. */
export function Composer({ busy, text, setText, onSend, onStop }: Props) {
  const submit = () => {
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
      <div className="mx-auto flex max-w-[720px] items-end gap-2 p-3">
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
          className="field-sizing-content block max-h-52 flex-1 min-h-11 resize-none rounded-xl border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted"
        />
        <Button
          type="submit"
          className="min-h-11 rounded-xl bg-accent px-4 font-medium text-accent-contrast data-pressed:opacity-90"
        >
          {busy ? "Stop" : "Send"}
        </Button>
      </div>
    </Form>
  );
}
