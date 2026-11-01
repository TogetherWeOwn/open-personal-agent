// SPDX-License-Identifier: Apache-2.0
// Activity › Outputs (M3-11, m3-ux §3.6): every file the assistant made, globally or for one
// chat, and a preview page per file with Download, its source run and Delete with Undo. HTML
// shows in an iframe with an empty `sandbox` (no scripts, no `allow-same-origin`), and the server
// serves it under CSP `sandbox` too, so nothing in it can reach the account.

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
import { ActivityNav } from "../activity/ActivityNav";
import { input } from "../auth/ui";
import { Markdown } from "../chat/Markdown";
import type { ConversationSummary } from "../chat/transport";
import { navigate } from "../router";
import { Banner, Button, buttonClass, Card, EmptyState, Page, Skeleton } from "../ui";
import {
  type Artifact,
  contentUrl,
  deleteLater,
  dismissFailure,
  formatSize,
  getArtifact,
  listArtifacts,
  PAGE,
  previewKind,
  typeName,
  undoDelete,
  useDeletes,
} from "./api";

const link = "font-medium text-accent underline underline-offset-2";
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

/** The run that wrote the file: its task when a Workflow ran it, else its chat. */
function SourceLink({ artifact }: { artifact: Artifact }) {
  if (artifact.taskId)
    return (
      <Link href={`/activity/tasks/${encodeURIComponent(artifact.taskId)}`} className={link}>
        Open source task
      </Link>
    );
  if (artifact.conversationId)
    return (
      <Link href={`/c/${encodeURIComponent(artifact.conversationId)}`} className={link}>
        Open source chat
      </Link>
    );
  return <span className="text-text-muted">The chat it came from was deleted.</span>;
}

/** The inline row m3-ux §4.5 uses in place of a toast: what was deleted, and Undo. */
function DeleteNotices() {
  const { pending, failed } = useDeletes();
  if (!pending.length && !failed.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {pending.map((a) => (
        <div
          key={a.id}
          role="status"
          className="flex items-center justify-between gap-3 rounded-lg bg-surface-sunken px-3"
        >
          <span className="min-w-0 truncate py-2">Deleted {a.name}.</span>
          <Button variant="quiet" onPress={() => undoDelete(a.id)}>
            Undo
          </Button>
        </div>
      ))}
      {failed.map((a) => (
        <Banner key={a.id} tone="danger" alert>
          I couldn't delete {a.name}. It's still in your files.{" "}
          <Button variant="quiet" onPress={() => dismissFailure(a.id)}>
            Dismiss
          </Button>
        </Banner>
      ))}
    </div>
  );
}

const chatFromUrl = () => new URLSearchParams(window.location.search).get("conversation") ?? "";

export function Outputs() {
  const [chat, setChat] = useState(chatFromUrl);
  const [chats, setChats] = useState<ConversationSummary[]>([]);
  const [files, setFiles] = useState<Artifact[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const { pending, gone } = useDeletes();
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
    listArtifacts(chat || undefined, last).then(
      (rows) => {
        setFiles((have) => [...(have ?? []), ...rows]);
        setMore(rows.length === PAGE);
      },
      () => setFailed(true),
    );
  };

  const hidden = new Set([...pending.map((a) => a.id), ...gone]);
  const shown = files?.filter((f) => !hidden.has(f.id)) ?? [];
  const known = chats.some((c) => c.id === chat);
  return (
    <Page title="Outputs">
      <ActivityNav current="outputs" />
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
      <DeleteNotices />
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

function Preview({ artifact }: { artifact: Artifact }) {
  const kind = previewKind(artifact.mediaType);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const download = (
    <a href={contentUrl(artifact.id, true)} download={artifact.name} className={buttonClass()}>
      Download
    </a>
  );

  useEffect(() => {
    if (kind !== "markdown" && kind !== "text") return;
    fetch(contentUrl(artifact.id))
      .then((res) => (res.ok ? res.text() : Promise.reject()))
      .then(setText, () => setFailed(true));
  }, [artifact.id, kind]);

  if (kind === "none" || failed)
    return (
      <Card>
        <div className="flex flex-col items-start gap-3">
          <p>I can't show a preview of this file.</p>
          {download}
        </div>
      </Card>
    );
  if (kind === "image")
    return (
      <img
        src={contentUrl(artifact.id)}
        alt={artifact.name}
        onError={() => setFailed(true)}
        className="max-h-[70vh] max-w-full self-start rounded-lg border border-border"
      />
    );
  if (kind === "html")
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-text-muted">
          Shown in a locked-down frame. Links and scripts in it can't reach your account.
        </p>
        <iframe
          src={contentUrl(artifact.id)}
          sandbox=""
          referrerPolicy="no-referrer"
          title={`Preview of ${artifact.name}`}
          className="h-[70vh] w-full rounded-lg border border-border bg-white"
        />
      </div>
    );
  if (text === null) return <Skeleton label="Loading the preview" />;
  if (kind === "markdown")
    return (
      <div className="rounded-xl border border-border p-4">
        <Markdown text={text} />
      </div>
    );
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-xl border border-border bg-surface-sunken p-4 text-sm whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

export function Output({ params }: { params: Record<string, string> }) {
  const id = params.outputId ?? "";
  const [artifact, setArtifact] = useState<Artifact | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the read on Try again
  useEffect(() => {
    let live = true;
    setFailed(false);
    getArtifact(id).then(
      (row) => live && setArtifact(row),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [id, attempt]);

  const all = (
    <Link href="/activity/outputs" className={link}>
      All files
    </Link>
  );
  if (failed)
    return (
      <Page title="Output">
        {all}
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>I couldn't load this file.</p>
          <Button onPress={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      </Page>
    );
  if (artifact === undefined)
    return (
      <Page title="Output">
        <Skeleton label="Loading the file" />
      </Page>
    );
  if (artifact === null)
    return (
      <Page title="Output">
        <EmptyState title="This file doesn't exist or was deleted." action={all} />
      </Page>
    );
  const remove = () => {
    deleteLater(artifact);
    navigate(
      artifact.conversationId
        ? `/activity/outputs?conversation=${encodeURIComponent(artifact.conversationId)}`
        : "/activity/outputs",
    );
  };
  return (
    <Page title={artifact.name}>
      {all}
      <div className="flex flex-col gap-1 text-text-muted">
        <p>
          {typeName(artifact.mediaType)} · {formatSize(artifact.sizeBytes)} ·{" "}
          {day(artifact.createdAt)}
        </p>
        <p>
          {artifact.conversationTitle ? `From “${artifact.conversationTitle}”. ` : ""}
          <SourceLink artifact={artifact} />
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a
          href={contentUrl(artifact.id, true)}
          download={artifact.name}
          className={buttonClass("primary")}
        >
          Download
        </a>
        <Button variant="quiet" onPress={remove}>
          Delete
        </Button>
      </div>
      <Preview artifact={artifact} />
    </Page>
  );
}
