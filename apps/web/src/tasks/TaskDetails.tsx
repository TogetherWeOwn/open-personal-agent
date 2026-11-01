// SPDX-License-Identifier: Apache-2.0
// One task (M3-13 AC1-2): its status, conversation, spend and timing, and stopping it while it
// still has a future. Stop writes the row first and asks the runtime to terminate best-effort,
// so where the runtime is unreachable the row still moves; a 409 means the run already ended,
// and the screen reloads to show that ending instead of arguing.
import { useCallback, useEffect, useState } from "react";
import { DialogTrigger, Link } from "react-aria-components";
import { Button, ConfirmDialog, EmptyState, Page, Skeleton, StatusChip } from "../ui";
import {
  costLabel,
  elapsed,
  isExecutionLimitKind,
  isInFlight,
  startedLabel,
  type TaskItem,
  taskTitle,
} from "./tasks";

const link = "font-medium text-accent underline underline-offset-2";

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-text-muted">{name}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

export function TaskDetails({ params }: { params: Record<string, string> }) {
  const id = params.taskId ?? "";
  const [task, setTask] = useState<TaskItem | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);

  const load = useCallback(() => {
    // The effect's cleanup flips this, so a load for one id can't overwrite another: without
    // it a slow response for task A lands after the move to task B and the screen shows A
    // while Stop would POST B's id.
    let live = true;
    setTask(null);
    setMissing(false);
    setFailed(false);
    fetch(`/api/tasks/${encodeURIComponent(id)}`)
      .then((res) => {
        if (!live) return null;
        if (res.status === 404) {
          setMissing(true);
          return null;
        }
        return res.ok ? res.json() : Promise.reject(new Error(String(res.status)));
      })
      .then(
        (body) => {
          if (live && body) setTask(body.task as TaskItem);
        },
        () => {
          if (live) setFailed(true);
        },
      );
    return () => {
      live = false;
    };
  }, [id]);

  useEffect(() => load(), [load]);

  const stop = () => {
    setStopping(true);
    setStopFailed(false);
    fetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" })
      .then((res) => {
        // 409 is agreement, not failure: the run already ended, so show that ending.
        if (res.ok || res.status === 409) {
          setStopping(false);
          load();
          return;
        }
        return Promise.reject(new Error(String(res.status)));
      })
      .catch(() => {
        setStopping(false);
        setStopFailed(true);
      });
  };

  if (missing) {
    return (
      <Page title="Task">
        <EmptyState
          title="This task doesn't exist or was deleted."
          action={
            <Link href="/activity/tasks" className={link}>
              See all tasks
            </Link>
          }
        />
      </Page>
    );
  }

  return (
    <Page title={task ? taskTitle(task) : "Task"}>
      {failed && <p role="alert">This task couldn&apos;t be loaded. Try again in a moment.</p>}
      {!failed && !task && <Skeleton label="Loading task" />}
      {!failed && task && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip status={task.status} limit={isExecutionLimitKind(task.limitKind)} />
            {isInFlight(task.status) && (
              <DialogTrigger>
                <Button variant="secondary">Stop task</Button>
                <ConfirmDialog
                  title={`Stop “${taskTitle(task)}”?`}
                  confirm="Stop task"
                  cancel="Keep it running"
                  danger
                  isConfirmDisabled={stopping}
                  onConfirm={stop}
                >
                  <p>
                    The run stops where it is. Anything it already did stays done, and its spend so
                    far stays spent.
                  </p>
                </ConfirmDialog>
              </DialogTrigger>
            )}
          </div>
          {stopFailed && (
            <p role="alert">The task couldn&apos;t be stopped. Try again in a moment.</p>
          )}
          {task.status === "budget_limited" && (
            <p className="text-sm text-text-muted">
              {isExecutionLimitKind(task.limitKind)
                ? "Paused: the run hit an execution limit, not money."
                : "Paused: the run spent its budget."}
            </p>
          )}
          {task.status === "failed" && task.error && (
            <p role="alert" className="break-words text-sm">
              {task.error}
            </p>
          )}
          <dl className="flex flex-col gap-3">
            <Fact name="Conversation">
              <Link href={`/c/${task.conversationId}`} className={link}>
                {task.conversationTitle ?? "Open conversation"}
              </Link>
            </Fact>
            <Fact name="Spend so far">{costLabel(task)}</Fact>
            {task.startedAt !== null && <Fact name="Started">{startedLabel(task.startedAt)}</Fact>}
            {(() => {
              const time = elapsed(task);
              return time ? <Fact name="Elapsed">{time}</Fact> : null;
            })()}
            {task.finishedAt !== null && <Fact name="Ended">{startedLabel(task.finishedAt)}</Fact>}
          </dl>
          <p>
            <Link href="/activity/tasks" className={link}>
              See all tasks
            </Link>
          </p>
        </>
      )}
    </Page>
  );
}
