// SPDX-License-Identifier: Apache-2.0
// Activity › Outputs (M3-11, m3-ux §3.6): every file the assistant made, globally or for one
// chat. Each opens its preview page.
import {
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  File as FileUnknown,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-aria-components";
import { input } from "../auth/ui";
import type { ConversationSummary } from "../chat/transport";
import { navigate } from "../router";
import { Button, EmptyState, Page, Skeleton } from "../ui";
import { type Artifact, formatSize, listArtifacts, PAGE, typeName } from "./api";

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

const ICONS: [RegExp, LucideIcon][] = [
  [/^image\//, FileImage],
  [/^text\/html$/, FileCode],
  [/^text\/csv$/, FileSpreadsheet],
  [/^application\/json$/, FileJson],
  [/^text\//, FileText],
];
const iconFor = (mediaType: string) =>
  ICONS.find(([type]) => type.test(mediaType))?.[1] ?? FileUnknown;

const chatFromUrl = () => new URLSearchParams(window.location.search).get("conversation") ?? "";

export function Outputs() {
  const [chat, setChat] = useState(chatFromUrl);
  const [chats, setChats] = useState<ConversationSummary[]>([]);
  const [files, setFiles] = useState<Artifact[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const filterId = useId();

  useEffect(() => {
    fetch("/api/conversations")
      .then((res) => (res.ok ? res.json() : { conversations: [] }))
      .then((body: { conversations?: ConversationSummary[] }) => setChats(body.conversations ?? []))
      .catch(() => {});
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read on Try again
  useEffect(() => {
    let live = true;
    setFiles(null);
    setFailed(false);
    listArtifacts(chat || undefined).then(
      (rows) => {
        if (!live) return;
        setFiles(rows);
        setMore(rows.length === PAGE);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [chat, attempt]);

  const pick = (id: string) => {
    setChat(id);
    navigate(
      id ? `/activity/outputs?conversation=${encodeURIComponent(id)}` : "/activity/outputs",
      true,
    );
  };

  const older = () => {
    const last = files?.at(-1);
    if (!last) return;
    listArtifacts(chat || undefined, last.createdAt).then(
      (rows) => {
        setFiles((have) => [...(have ?? []), ...rows]);
        setMore(rows.length === PAGE);
      },
      () => setFailed(true),
    );
  };

  const shown = files ?? [];
  const known = chats.some((c) => c.id === chat);
  return (
    <Page title="Outputs">
      <div className="flex flex-col gap-1 sm:max-w-xs">
        <label htmlFor={filterId} className="font-medium">
          Chat
        </label>
        <select
          id={filterId}
          value={chat}
          onChange={(e) => pick(e.target.value)}
          className={`${input} font-sans`}
        >
          <option value="">All chats</option>
          {chat && !known && <option value={chat}>This chat</option>}
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title ?? "New chat"}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>I couldn't load your files.</p>
          <Button onPress={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      )}
      {!failed && !files && <Skeleton label="Loading your files" />}
      {files &&
        !shown.length &&
        !more &&
        (chat ? (
          <EmptyState
            title="No files from this chat yet."
            action={
              <Button variant="quiet" onPress={() => pick("")}>
                All files
              </Button>
            }
          />
        ) : (
          <EmptyState title="Files I make for you show up here, like summaries and reports." />
        ))}
      {shown.length > 0 && (
        <ul aria-label="Files" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((f) => {
            const Icon = iconFor(f.mediaType);
            return (
              <li key={f.id}>
                <Link
                  href={`/activity/outputs/${encodeURIComponent(f.id)}`}
                  className="flex h-full gap-3 rounded-xl border border-border bg-surface-raised p-3 hover:border-border-strong"
                >
                  <Icon aria-hidden="true" size={24} className="mt-0.5 shrink-0 text-text-muted" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{f.name}</span>
                    <span className="truncate text-sm text-text-muted">
                      {typeName(f.mediaType)} · {formatSize(f.sizeBytes)}
                    </span>
                    <span className="truncate text-sm text-text-muted">
                      {f.conversationTitle ? `${f.conversationTitle} · ` : ""}
                      {day(f.createdAt)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {files && more && (
        <Button variant="secondary" onPress={older} className="self-start">
          Show older files
        </Button>
      )}
    </Page>
  );
}
