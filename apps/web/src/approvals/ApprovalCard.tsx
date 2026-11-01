// SPDX-License-Identifier: Apache-2.0
// The approval card and the multi-action card (M3-07 AC6, AC7, AC11; m3-ux §3.3). One component
// for the thread and the Inbox. Nothing has focus by default and Enter alone never approves
// (UX-04): the user tabs to the button and presses Space, or clicks it.
import type { ApprovalDecision, ApprovalItem } from "@opa/core";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { Button, Card, CardHeader } from "../ui";
import { decide, type PendingBatch } from "./api";
import { actionOf, expiresIn, needsPasskey, STANDING_NOTE, scopeLabel } from "./copy";
import { ItemBody } from "./ItemBody";
import { decided, refreshApprovals } from "./store";

type Scope = ApprovalItem["scopes"][number];

/** The current time, re-read once a minute: the expiry line never ticks every second. */
function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** True below 640 px, where a multi-action card opens only its first item. */
function useNarrow() {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return narrow;
}

/** Enter does nothing on the approve button (M3-07 AC7); Space and a click still press it. */
const noEnter = (e: KeyboardEvent) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.stopPropagation();
};

/** The scopes every remaining item allows, and the item that held it to "once", if one did. */
function offered(items: readonly ApprovalItem[]): { scopes: Scope[]; because?: ApprovalItem } {
  if (!items.length) return { scopes: ["once"] };
  const scopes = (items[0]?.scopes ?? ["once"]).filter((s) =>
    items.every((i) => i.scopes.includes(s)),
  );
  const because =
    scopes.length === 1 && items.length > 1 ? items.find((i) => i.scopes.length === 1) : undefined;
  return { scopes: scopes.length ? scopes : ["once"], ...(because ? { because } : {}) };
}

const FAILURES = {
  not_confirmed: "Not confirmed. Nothing was done.",
  changed: "This request changed or was already handled. Review it again.",
  expired: "This request expired, so I stopped it.",
  cancelled: "The task was cancelled, so nothing will run.",
  offline: "That didn't reach your assistant. Try again.",
};

export function ApprovalCard({
  batch,
  level = 3,
  context,
}: {
  batch: PendingBatch;
  level?: number;
  /** The conversation or task it belongs to, as a link, in the Inbox. */
  context?: ReactNode;
}) {
  const headingId = `approval-${batch.batchId}`;
  const now = useMinute();
  const narrow = useNarrow();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = useState<Scope>("once");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const hintId = useId();

  const { items } = batch;
  const multi = items.length > 1;
  const remaining = items.filter((i) => !removed.has(i.approvalId));
  const { scopes, because } = offered(remaining);
  const chosen = scopes.includes(scope) ? scope : "once";
  const passkey = remaining.some(needsPasskey);
  const expired = batch.expiresAt <= now;

  const submit = async (allow: boolean) => {
    const decisions: ApprovalDecision[] = items.map((i) => {
      const approve = allow && !removed.has(i.approvalId);
      return {
        approvalId: i.approvalId,
        decision: approve ? "approve" : "deny",
        scope: approve ? chosen : "once",
      };
    });
    setSending(true);
    setFailure(null);
    const result = await decide(batch.batchId, items, decisions);
    setSending(false);
    if (result.kind === "done") return decided(batch, decisions, result);
    setFailure(FAILURES[result.kind]);
    if (result.kind !== "not_confirmed" && result.kind !== "offline") void refreshApprovals();
  };

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const title = multi
    ? `${items.length} actions need your OK`
    : `${actionOf(items[0]?.tool ?? "")} · Needs your OK`;

  return (
    <Card tone="approval" labelledBy={headingId} className={expired ? "opacity-60" : ""}>
      <CardHeader id={headingId} level={level} title={title} />
      {multi && <p>{items.map((i) => actionOf(i.tool)).join(" · ")}</p>}
      {context}
      <p className="text-sm text-text-muted">
        {expired ? "Expired. I stopped this." : expiresIn(batch.expiresAt, now)}
      </p>
      {multi ? (
        items.map((item, n) => {
          const id = `approval-item-${item.approvalId}`;
          const name = actionOf(item.tool);
          if (removed.has(item.approvalId)) {
            return (
              <div key={item.approvalId} className="flex flex-wrap items-center gap-2">
                <p className="text-text-muted line-through">Removed: {name}.</p>
                <p className="text-text-muted">I won't do this one.</p>
                <Button
                  variant="quiet"
                  isDisabled={sending}
                  onPress={() => setRemoved(toggle(removed, item.approvalId))}
                  aria-label={`Undo: ${name}`}
                >
                  Undo
                </Button>
              </div>
            );
          }
          const open = !narrow || n === 0 || shown.has(item.approvalId);
          return (
            <section
              key={item.approvalId}
              aria-labelledby={id}
              className="flex flex-col gap-3 rounded-lg border border-approval-border p-3"
            >
              <CardHeader id={id} level={level + 1} title={`${n + 1} of ${items.length}: ${name}`}>
                <Button
                  variant="quiet"
                  isDisabled={sending}
                  onPress={() => setRemoved(toggle(removed, item.approvalId))}
                  aria-label={`Don't do this one: ${name}`}
                >
                  Don't do this one
                </Button>
              </CardHeader>
              {open ? (
                <ItemBody item={item} />
              ) : (
                <>
                  {item.target && <p className="break-all">To: {item.target}</p>}
                  <Button
                    variant="quiet"
                    className="self-start"
                    onPress={() => setShown(toggle(shown, item.approvalId))}
                    aria-label={`Show: ${name}`}
                  >
                    Show
                  </Button>
                </>
              )}
            </section>
          );
        })
      ) : items[0] ? (
        <ItemBody item={items[0]} />
      ) : null}
      {!expired && remaining.length > 0 && (
        <div className="flex flex-col gap-1">
          {scopes.length > 1 ? (
            <RadioGroup
              value={chosen}
              onChange={(v) => setScope(v as Scope)}
              isDisabled={sending}
              className="flex flex-col gap-1"
            >
              <Label className="font-medium">Allow</Label>
              {scopes.map((s) => (
                <Radio
                  key={s}
                  value={s}
                  className="flex min-h-11 cursor-default items-center gap-2 rounded-lg px-2 before:size-4 before:shrink-0 before:rounded-full before:border-2 before:border-border-strong data-focus-visible:outline-2 data-selected:before:border-[5px] data-selected:before:border-accent"
                >
                  {scopeLabel(s, remaining[0]?.target)}
                </Radio>
              ))}
            </RadioGroup>
          ) : (
            <p>
              <span className="font-medium">Allow: </span>Just this once
            </p>
          )}
          {because && (
            <p className="text-sm text-text-muted">
              Only once, because of {actionOf(because.tool)}.
            </p>
          )}
          {chosen !== "once" && <p className="text-sm text-text-muted">{STANDING_NOTE}</p>}
        </div>
      )}
      {sending && (
        <p role="status" className="text-sm">
          Sending your answer…
        </p>
      )}
      {failure && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
      {!expired && (
        <div className="flex flex-wrap gap-2">
          {remaining.length > 0 && (
            <span className="contents" onKeyDownCapture={noEnter} onKeyUpCapture={noEnter}>
              <Button
                variant="primary"
                isDisabled={sending}
                aria-describedby={hintId}
                onPress={() => void submit(true)}
              >
                {multi
                  ? `${passkey ? "Confirm" : "Allow"} ${remaining.length} ${remaining.length === 1 ? "action" : "actions"}${passkey ? " with passkey…" : ""}`
                  : passkey
                    ? "Confirm with passkey…"
                    : "Allow"}
              </Button>
            </span>
          )}
          <Button isDisabled={sending} onPress={() => void submit(false)}>
            {remaining.length === 0
              ? "Done: allow none"
              : multi
                ? "Don't allow any"
                : "Don't allow"}
          </Button>
          <span id={hintId} className="sr-only">
            Press Space to choose. Enter does nothing here.
          </span>
        </div>
      )}
    </Card>
  );
}

/** Brings a card (by its heading's or item's id) into view and moves focus to it. */
export function focusApproval(id: string): boolean {
  const el = document.getElementById(id);
  if (!el) return false;
  el.setAttribute("tabindex", "-1");
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
  return true;
}
