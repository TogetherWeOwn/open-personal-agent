// SPDX-License-Identifier: Apache-2.0
// "What my assistant knows about me" (M3-15 AC4): every current note as Markdown, in the preview
// sheet, through the same safe renderer as the chat.
import { useEffect, useState } from "react";
import { Markdown } from "../chat/Markdown";
import { Sheet } from "../ui";
import { listNotes } from "./api";
import { knowsMarkdown } from "./markdown";

export function Knows({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    setText(null);
    listNotes().then(
      (notes) => setText(knowsMarkdown(notes)),
      () => setText("I couldn't load your notes. Close this and try again."),
    );
  }, [isOpen]);
  return (
    <Sheet title="What my assistant knows about me" isOpen={isOpen} onOpenChange={onOpenChange}>
      {text === null ? <p>Loading…</p> : <Markdown text={text} />}
    </Sheet>
  );
}
