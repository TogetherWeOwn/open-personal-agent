// SPDX-License-Identifier: Apache-2.0
// Activity › Log (M3-19 AC3, m3-ux §3.8): sign-ins, passkeys, sessions, saved keys (never their
// values), approvals with their scope, tool-setting changes, exports, deletions and settings
// changes, grouped by day, newest first. Filter by kind; search. Each row opens Details with the
// raw record. Read-only in M3: standing grants are revoked from Settings › Privacy & security.
import { useEffect, useId, useRef, useState } from "react";
import { Input, Label, Link, SearchField } from "react-aria-components";
import { Button, Disclosure, EmptyState, Page, Skeleton } from "../ui";
import { byDay, fetchLog, LOG_KINDS, type LogEntry, type LogKind, rawRecord, summary } from "./log";

const input = "min-h-11 rounded-lg border border-border-strong bg-surface px-3";
const link = "font-medium text-accent underline underline-offset-2";

function Row({ entry }: { entry: LogEntry }) {
  const line = summary(entry);
  const time = new Date(entry.at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <li className="rounded-xl border border-border bg-surface-raised p-3">
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{entry.title}</span>
        <time dateTime={new Date(entry.at).toISOString()} className="text-sm text-text-muted">
          {time}
        </time>
      </p>
      {line && <p className="mt-1 text-sm text-text-muted break-words">{line}</p>}
      <Disclosure summary="Details">
        <pre className="overflow-x-auto rounded-lg bg-surface p-2 text-xs">{rawRecord(entry)}</pre>
      </Disclosure>
    </li>
  );
}

export function ActivityLog() {
  const kindId = useId();
  const [kind, setKind] = useState<LogKind | "">("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState({ kind: "" as LogKind | "", q: "" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [added, setAdded] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Bumped on every new filter or search: a page fetched for an earlier one is dropped.
  const visit = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Try again trigger.
  useEffect(() => {
    const mine = ++visit.current;
    const q = query.trim();
    const timer = setTimeout(
      () => {
        setFailed(false);
        setMoreFailed(false);
        setAdded("");
        fetchLog({ kind, q }).then(
          (page) => {
            if (visit.current !== mine) return;
            setEntries(page.entries);
            setNext(page.next);
            setShown({ kind, q });
          },
          () => visit.current === mine && setFailed(true),
        );
      },
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [kind, query, attempt]);

  const showOlder = () => {
    if (next === null || loadingMore) return;
    const mine = visit.current;
    setLoadingMore(true);
    setMoreFailed(false);
    fetchLog({ ...shown, before: next }).then(
      (page) => {
        if (visit.current !== mine) return;
        setEntries((have) => [...(have ?? []), ...page.entries]);
        setNext(page.next);
        const n = page.entries.length;
        setAdded(`${n} older ${n === 1 ? "entry" : "entries"} added.`);
        setLoadingMore(false);
      },
      () => {
        if (visit.current !== mine) return;
        setMoreFailed(true);
        setLoadingMore(false);
      },
    );
  };

  const filtered = shown.kind !== "" || shown.q !== "";
  const clear = () => {
    setKind("");
    setQuery("");
  };

  return (
    <Page title="Activity log">
      <p className="text-text-muted">
        What happened in your account over the last 365 days. To stop allowing something you
        approved, go to{" "}
        <Link href="/settings/privacy" className={link}>
          Settings › Privacy &amp; security
        </Link>
        .
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1 sm:w-64">
          <label htmlFor={kindId} className="text-sm font-medium">
            Show
          </label>
          <select
            id={kindId}
            value={kind}
            onChange={(e) => setKind(e.target.value as LogKind | "")}
            className={`${input} font-sans`}
          >
            <option value="">Everything</option>
            {LOG_KINDS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <SearchField value={query} onChange={setQuery} className="flex flex-1 flex-col gap-1">
          <Label className="text-sm font-medium">Search the log</Label>
          <Input className={input} maxLength={100} />
        </SearchField>
      </div>
      {failed ? (
        <EmptyState
          title="I couldn't load the activity log."
          action={<Button onPress={() => setAttempt((n) => n + 1)}>Try again</Button>}
        />
      ) : entries === null ? (
        <Skeleton label="Loading the activity log" />
      ) : entries.length === 0 && filtered ? (
        <EmptyState
          title={shown.q ? `Nothing matches "${shown.q}".` : "Nothing of this kind yet."}
          action={<Button onPress={clear}>Show everything</Button>}
        />
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing has happened yet." />
      ) : (
        <div className="flex flex-col gap-6">
          {byDay(entries, Date.now()).map((group) => (
            <section key={`${group.day}-${group.entries[0]?.id}`} className="flex flex-col gap-2">
              <h2 className="font-semibold">{group.day}</h2>
              <ul className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <Row key={entry.id} entry={entry} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!failed && entries !== null && entries.length > 0 && next !== null && (
        <Button isPending={loadingMore} onPress={showOlder} className="self-start">
          {loadingMore ? "Loading older entries…" : "Show older entries"}
        </Button>
      )}
      {!failed && entries !== null && entries.length > 0 && next === null && (
        <p className="text-sm text-text-muted">
          That&apos;s everything from the last 365 days. Older entries are removed automatically.
        </p>
      )}
      <p role="status" className="sr-only">
        {added}
      </p>
      {moreFailed && (
        <p role="alert">Older entries couldn&apos;t be loaded. Try again in a moment.</p>
      )}
    </Page>
  );
}
