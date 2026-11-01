// SPDX-License-Identifier: Apache-2.0
// The Tasks list (M3-13 AC1-2): Now (queued, working, waiting, paused) and History (over,
// one way or another). Each tab fetches its statuses from `GET /api/tasks`, so the filter is
// the server's, not a client guess. A row names the task, chips its status (a `budget_limited`
// stop by an execution limit reads "Paused: limit", never "budget"), and shows the spend and
// elapsed time so far. A tab shows a page at a time; "Show older tasks" fetches the next one
// with the same statuses (TWO-713).
import { useEffect, useRef, useState } from "react";
import { Link, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Button, EmptyState, Page, Skeleton, StatusChip } from "../ui";
import {
  addPage,
  costLabel,
  elapsed,
  HISTORY_STATUSES,
  isExecutionLimitKind,
  listQuery,
  NOW_STATUSES,
  type TaskItem,
  type TaskPages,
  taskTitle,
} from "./tasks";

async function fetchPage(tab: "now" | "history", until: number | null): Promise<TaskItem[]> {
  const res = await fetch(
    `/api/tasks?${listQuery(tab === "now" ? NOW_STATUSES : HISTORY_STATUSES, until)}`,
  );
  if (!res.ok) throw new Error(String(res.status));
  return ((await res.json()) as { tasks: TaskItem[] }).tasks;
}

function TaskRow({ task }: { task: TaskItem }) {
  const time = elapsed(task);
  return (
    <li>
      <Link
        href={`/activity/tasks/${task.id}`}
        className="block rounded-xl border border-border bg-surface-raised p-4"
      >
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{taskTitle(task)}</span>
          <StatusChip status={task.status} limit={isExecutionLimitKind(task.limitKind)} />
        </span>
        <span className="mt-1 block text-sm text-text-muted">
          {task.conversationTitle ?? "A conversation"} · {costLabel(task)}
          {time && ` · ${time}`}
        </span>
      </Link>
    </li>
  );
}

export function Tasks() {
  const [tab, setTab] = useState<"now" | "history">("now");
  const [pages, setPages] = useState<TaskPages | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  // Focus stays on "Show older tasks" while rows land above it, so a status line says so.
  const [added, setAdded] = useState("");
  // Bumped on every tab switch: a page fetched for an earlier visit to a tab is dropped.
  const visit = useRef(0);

  useEffect(() => {
    // A late response for one tab must not overwrite the other: without this a slow Now
    // fetch lands after the move to History and swaps its rows out from under the toggle.
    const mine = ++visit.current;
    setPages(null);
    setFailed(false);
    setLoadingMore(false);
    setMoreFailed(false);
    setAdded("");
    fetchPage(tab, null).then(
      (page) => {
        if (visit.current === mine) setPages(addPage([], page));
      },
      () => {
        if (visit.current === mine) setFailed(true);
      },
    );
  }, [tab]);

  const showOlder = () => {
    if (pages?.until == null || loadingMore) return;
    const mine = visit.current;
    setLoadingMore(true);
    setMoreFailed(false);
    fetchPage(tab, pages.until).then(
      (page) => {
        if (visit.current !== mine) return;
        const next = addPage(pages.tasks, page);
        const count = next.tasks.length - pages.tasks.length;
        setPages(next);
        setAdded(`${count} older ${count === 1 ? "task" : "tasks"} added.`);
        setLoadingMore(false);
      },
      () => {
        if (visit.current !== mine) return;
        setMoreFailed(true);
        setLoadingMore(false);
      },
    );
  };

  const tasks = pages?.tasks ?? null;

  return (
    <Page title="Tasks">
      {/* The toggle stays mounted while a tab loads or fails, so the other tab is one press
        away and focus survives the switch. */}
      <ToggleButtonGroup
        aria-label="Which tasks"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[tab]}
        onSelectionChange={(keys) => setTab([...keys][0] === "history" ? "history" : "now")}
        className="flex self-start rounded-lg border border-border-strong"
      >
        {(["now", "history"] as const).map((id) => (
          <ToggleButton
            key={id}
            id={id}
            className="min-h-11 rounded-lg px-4 font-medium data-selected:bg-accent data-selected:text-accent-contrast"
          >
            {id === "now" ? "Now" : "History"}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {failed && <p role="alert">Tasks couldn&apos;t be loaded. Try again in a moment.</p>}
      {!failed && tasks === null && <Skeleton label="Loading tasks" />}
      {!failed &&
        tasks !== null &&
        (tasks.length === 0 ? (
          <EmptyState title={tab === "now" ? "No tasks running." : "No finished tasks yet."}>
            When I work on something for you, it shows up here.
          </EmptyState>
        ) : (
          <ul
            aria-label={tab === "now" ? "Tasks now" : "Task history"}
            className="flex flex-col gap-2"
          >
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        ))}
      {!failed && pages?.until != null && (
        <Button isPending={loadingMore} onPress={showOlder} className="self-start">
          {loadingMore ? "Loading older tasks…" : "Show older tasks"}
        </Button>
      )}
      <p role="status" className="sr-only">
        {added}
      </p>
      {moreFailed && (
        <p role="alert">Older tasks couldn&apos;t be loaded. Try again in a moment.</p>
      )}
    </Page>
  );
}
