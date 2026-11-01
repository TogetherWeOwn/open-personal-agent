// SPDX-License-Identifier: Apache-2.0
// The turn timeline (M3-09 AC1-3, AC5, m3-ux §3.1): the running header with its ticking
// elapsed time and "still working" timer, the step list with tool cards, the collapsed "Worked
// for …" summary and the taint marker. The reply streams below as `children`, so the thread
// keeps one view per message. (Queued sends bubble up in the next part.)

import { CircleCheck, CircleX, FileText, Globe, Hand, Loader } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Disclosure, StatusChip } from "../ui";
import type { ShowWork } from "./show-work";
import type { Turn, TurnStep, TurnTaint, TurnTool } from "./state";
import { ToolCard } from "./ToolCard";
import {
  failedTools,
  formatDuration,
  formatElapsed,
  formatSummary,
  isStillWorking,
  type PriceTable,
  turnCostMicroUsd,
  turnStatus,
} from "./turn-summary";

interface TurnProps {
  turn: Turn;
  showWork: ShowWork;
  prices: PriceTable;
}

export function TurnView({
  turn,
  showWork,
  prices,
  children,
}: TurnProps & { children: ReactNode }) {
  const [, setTick] = useState(0);
  const live =
    turn.outcome === "running" || turn.outcome === "waiting" || turn.outcome === "limited";
  // The ticking header (M3-09 AC1): a slow run is never more than a second without motion.
  useEffect(() => {
    if (turn.outcome !== "running") return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [turn.outcome]);
  const now = Date.now();
  const steps = turn.steps;
  const current = [...steps].reverse().find((s) => s.status === "running") ?? steps.at(-1) ?? null;
  const elapsed = formatElapsed(Math.max(0, now - turn.startedAt));
  // Visual only: the app's status region announces the turn's start and finish (UX §4.2).
  // A paused turn reads paused, never working: its timer stopped at the pause, and the chip
  // below names the pause (M3-09 AC1).
  const header =
    turn.outcome !== "running"
      ? current === null
        ? `Paused · ${elapsed}`
        : `Paused · ${elapsed} · ${current.label}`
      : current === null
        ? `Working · ${elapsed}`
        : isStillWorking(turn, now)
          ? `Still working on: ${current.label} · ${elapsed}`
          : `Working · ${elapsed} · ${current.label}`;
  const summary = formatSummary({
    durationMs: Math.max(0, (live ? now : turn.updatedAt) - turn.startedAt),
    tools: turn.tools.length,
    failed: failedTools(turn).length,
    costMicroUsd: turnCostMicroUsd(turn.usage, prices),
  });
  const expandTools = showWork === "expanded";
  const list = showWork !== "hidden" && <StepList turn={turn} expandTools={expandTools} />;
  // A failed tool stays visible past the run (M3-09 AC2): the finished view folds every step
  // into the summary, so the failures list beside it, outside the Disclosure.
  const failed = failedTools(turn);
  const failures = failed.length > 0 && (
    <ul aria-label="Failed tools" className="flex flex-col gap-1">
      {failed.map((tool) => (
        <li key={tool.toolCallId} className="inline-flex items-center gap-1.5 text-sm">
          <CircleX aria-hidden="true" size={14} className="shrink-0 text-danger" />
          <span className="font-mono">{tool.tool}</span>
          <span className="text-danger">
            <span aria-hidden="true">✕ </span>Failed
          </span>
        </li>
      ))}
    </ul>
  );
  if (live) {
    return (
      <div className="flex flex-col gap-2">
        <p aria-hidden="true" className="text-sm text-text-muted">
          {header}
        </p>
        {turn.outcome !== "running" && (
          <p>
            <StatusChip status={turnStatus(turn)} />
          </p>
        )}
        {list}
        {children}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {showWork === "hidden" ? (
        <p className="text-sm text-text-muted">{summary}</p>
      ) : (
        <Disclosure summary={<span className="text-sm text-text-muted">{summary}</span>}>
          {turn.outcome !== "succeeded" && (
            <p className="mb-1">
              <StatusChip status={turnStatus(turn)} />
            </p>
          )}
          {list}
        </Disclosure>
      )}
      {failures}
      {children}
    </div>
  );
}

function StepList({ turn, expandTools }: { turn: Turn; expandTools: boolean }) {
  const stepIds = new Set(turn.steps.map((s) => s.stepId));
  const byStep = new Map<string, TurnTool>();
  for (const tool of turn.tools) {
    if (tool.stepId && stepIds.has(tool.stepId)) byStep.set(tool.stepId, tool);
  }
  const loose = turn.tools.filter((t) => !t.stepId || !stepIds.has(t.stepId));
  const taints = new Map<string, TurnTaint[]>();
  for (const taint of turn.taint) {
    taints.set(taint.stepId, [...(taints.get(taint.stepId) ?? []), taint]);
  }
  // The tainted step carries the chip; every later step carries the rule (UX §3.7).
  const firstTainted = turn.steps.findIndex((s) => taints.has(s.stepId));
  if (turn.steps.length === 0 && loose.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1">
      {turn.steps.map((step, i) => (
        <StepRow
          key={step.stepId}
          step={step}
          tool={byStep.get(step.stepId)}
          taints={taints.get(step.stepId) ?? []}
          ruled={firstTainted !== -1 && i > firstTainted}
          expandTools={expandTools}
        />
      ))}
      {loose.map((tool) => (
        <li key={tool.toolCallId}>
          <ToolCard tool={tool} {...(expandTools ? { defaultOpen: true } : {})} />
        </li>
      ))}
    </ol>
  );
}

function StepRow({
  step,
  tool,
  taints,
  ruled,
  expandTools,
}: {
  step: TurnStep;
  tool: TurnTool | undefined;
  taints: TurnTaint[];
  ruled: boolean;
  expandTools: boolean;
}) {
  // The taint chip sits on the row itself (m3-ux §3.1): in the default Collapsed mode the
  // marker shows without opening the step. The Disclosure keeps the why and the tool card.
  const summary = (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <StepIcon status={step.status} />
      <span>{step.label}</span>
      {step.status === "denied" && <span className="text-text-muted">· Not approved</span>}
      {step.durationMs !== null && (
        <span className="text-text-muted">· {formatDuration(step.durationMs)}</span>
      )}
      {taints.map((taint) => (
        <TaintChip key={`${taint.kind}:${taint.label}`} taint={taint} />
      ))}
    </span>
  );
  if (taints.length === 0 && tool === undefined) {
    return <li className={ruled ? "border-l-2 border-border pl-3" : undefined}>{summary}</li>;
  }
  return (
    <li className={ruled ? "border-l-2 border-border pl-3" : undefined}>
      <Disclosure summary={summary} defaultExpanded={expandTools && tool !== undefined}>
        {taints.length > 0 && (
          <p className="mb-1 text-sm text-text-muted">
            Text from outside sources can try to steer me, so I ask before sending anything out.
          </p>
        )}
        {tool && <ToolCard tool={tool} {...(expandTools ? { defaultOpen: true } : {})} />}
      </Disclosure>
    </li>
  );
}

function StepIcon({ status }: { status: TurnStep["status"] }) {
  if (status === "running") {
    return <Loader aria-hidden="true" size={14} className="shrink-0 motion-safe:animate-spin" />;
  }
  if (status === "ok") return <CircleCheck aria-hidden="true" size={14} className="shrink-0" />;
  if (status === "denied") return <Hand aria-hidden="true" size={14} className="shrink-0" />;
  return <CircleX aria-hidden="true" size={14} className="shrink-0" />;
}

const taintCopy = {
  web: "From the web",
  file: "From a file",
  tool: "From a tool result",
} as const;

/** Where outside content entered the context (M3-09 AC5, SEC-5): the step it rode in on. */
function TaintChip({ taint }: { taint: TurnTaint }) {
  const Icon = taint.kind === "web" ? Globe : FileText;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-sm font-medium"
      title="Content from outside is in context from here"
    >
      <Icon aria-hidden="true" size={14} />
      {taintCopy[taint.kind]}: {taint.label}
    </span>
  );
}
