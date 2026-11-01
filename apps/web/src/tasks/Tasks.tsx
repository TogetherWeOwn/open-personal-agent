// SPDX-License-Identifier: Apache-2.0
// The Tasks list (M3-13 AC1-2): Now (queued, working, waiting, paused) and History (over,
// one way or another). Each tab fetches its statuses from `GET /api/tasks`, so the filter is
// the server's, not a client guess. A row names the task, chips its status (a `budget_limited`
// stop by an execution limit reads "Paused: limit", never "budget"), and shows the spend and
// elapsed time so far.
import { useEffect, useState } from "react";
import { Link, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { EmptyState, Page, Skeleton, StatusChip } from "../ui";
import {
  costLabel,
  elapsed,
  HISTORY_STATUSES,
  isExecutionLimitKind,
  listQuery,
  NOW_STATUSES,
  type TaskItem,
  taskTitle,
} from "./tasks";

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
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setTasks(null);
    setFailed(false);
    fetch(`/api/tasks?${listQuery(tab === "now" ? NOW_STATUSES : HISTORY_STATUSES)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(
        (body) => setTasks(body.tasks as TaskItem[]),
        () => setFailed(true),
      );
  }, [tab]);

  return (
    <Page title="Tasks">
      {failed && <p role="alert">Tasks couldn&apos;t be loaded. Try again in a moment.</p>}
      {!failed && tasks === null && <Skeleton label="Loading tasks" />}
      {!failed && tasks !== null && (
        <>
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
          {tasks.length === 0 ? (
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
          )}
        </>
      )}
    </Page>
  );
}
