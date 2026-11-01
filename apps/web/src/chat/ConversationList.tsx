// SPDX-License-Identifier: Apache-2.0
import { ListBox, ListBoxItem } from "react-aria-components";
import type { Conversation } from "./state";

interface Props {
  conversations: Conversation[];
  activeId: string;
  onOpen: (id: string) => void;
}

export function ConversationList({ conversations, activeId, onOpen }: Props) {
  return (
    <ListBox
      aria-label="Conversations"
      items={conversations}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[activeId]}
      onSelectionChange={(keys) => {
        if (keys !== "all") for (const key of keys) onOpen(String(key));
      }}
      className="flex-1 overflow-y-auto px-3 pb-3"
    >
      {(c) => (
        <ListBoxItem
          id={c.id}
          textValue={c.title}
          // A press opens the conversation even when it is already selected (the 375 px list view).
          onPress={() => onOpen(c.id)}
          className="min-h-11 cursor-default truncate rounded-lg px-3 py-2.5 hover:bg-surface-raised data-selected:bg-surface-raised data-selected:font-semibold"
        >
          {c.title}
        </ListBoxItem>
      )}
    </ListBox>
  );
}
