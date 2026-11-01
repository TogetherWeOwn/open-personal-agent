// SPDX-License-Identifier: Apache-2.0
// The approval card and the multi-action card (M3-07 AC6, AC7, AC11; m3-ux §3.3). One component
// for the thread and the Inbox. Nothing has focus by default and Enter alone never approves
// (UX-04): the user tabs to the button and presses Space, or clicks it. In `sample` mode (onboarding's
// Safety step) its buttons work but act on nothing.
import type { ApprovalDecision, ApprovalItem } from "@opa/core";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { Button, Card, CardHeader } from "../ui";
import type { PendingBatch } from "./api";
import { actionOf, expiresIn, needsPasskey, STANDING_NOTE, scopeLabel } from "./copy";
import { ItemBody, TargetLine, Visible } from "./ItemBody";
import { claimFocus, refreshApprovals, submitDecision, useApprovals } from "./store";

type Scope = ApprovalItem["scopes"][number];

/**
 * The current time, re-read when the expiry line would change: each hour, then each minute, and
 * each second only in the last minute (m3-ux §3.3), and once more as it expires.
 */
function useExpiryClock(expiresAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const left = expiresAt - now;
    if (left <= 0) return;
    const unit = left > 3_600_000 ? 3_600_000 : left > 60_000 ? 60_000 : 1000;
    const timer = setTimeout(() => setNow(Date.now()), left % unit || unit);
    return () => clearTimeout(timer);
  }, [expiresAt, now]);
  return now;
}

/** "Always for a.com and b.org": every host a destination grant would cover, as it reads. */
function Destinations({ items }: { items: readonly ApprovalItem[] }) {
  const hosts = [...new Set(items.flatMap((i) => (i.target ? [i.target] : [])))];
  if (!hosts.length) return <>{scopeLabel("destination")}</>;
  return (
    <span>
      Always for{" "}
      {hosts.map((h, n) => (
        <span key={h}>
          {n > 0 && (n === hosts.length - 1 ? " and " : ", ")}
          <Visible text={h} />
        </span>
      ))}
    </span>
  );
}

/** Why Allow is missing: a request saved damaged can only be declined, or removed from a batch. */
function damagedText(damaged: readonly ApprovalItem[], multi: boolean): string {
  const one = damaged.length === 1;
  if (!multi) return "I can't let you allow this: part of what I saved for it is damaged.";
  return `I can't let you allow ${damaged.map((i) => actionOf(i.tool)).join(", ")}: part of what I saved for ${one ? "it" : "them"} is damaged. Remove ${one ? "it" : "them"} to allow the rest.`;
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
  changed: "This request changed. Review it again.",
  expired: "This request expired, so I stopped it.",
  cancelled: "The task was cancelled, so nothing will run.",
  offline: "That didn't reach your assistant. Try again.",
};

export function ApprovalCard({
  batch,
  level = 3,
  context,
  idPrefix = "approval",
  where,
  sample = false,
}: {
  batch: PendingBatch;
  level?: number;
  /** The conversation or task it belongs to, as a link, in the Inbox. */
  context?: ReactNode;
  /** Its ids' prefix: the Inbox's own, so its card and the hidden chat's never share one. */
  idPrefix?: string;
  /** Its chat's title, in the card's name, so two alike cards in the Inbox stay apart. */
  where?: string;
  /** Onboarding's sample: a "Sample" badge, and an answer only shows how it works. */
  sample?: boolean;
}) {
  const headingId = `${idPrefix}-${batch.batchId}`;
  const now = useExpiryClock(batch.expiresAt);
  const narrow = useNarrow();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = useState<Scope>("once");
  // The item whose remove/undo button was just pressed: that button leaves the DOM, so focus
  // moves to its counterpart (never to Allow, UX-04).
  const [moved, setMoved] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const hintId = useId();
  const toggleId = (approvalId: string) => `${idPrefix}-toggle-${approvalId}`;

  useEffect(() => {
    if (!moved) return;
    document.getElementById(toggleId(moved))?.focus();
    setMoved(null);
  });

  // Opened by its deep link: once the chat shows it, the card takes focus. After this commit's
  // effects, so the chat's own focus on its heading doesn't take it back.
  const { focus } = useApprovals();
  useEffect(() => {
    if (focus !== batch.batchId) return;
    const timer = setTimeout(() => claimFocus(batch.batchId) && focusApproval(headingId));
    return () => clearTimeout(timer);
  }, [focus, batch.batchId, headingId]);

  const { items } = batch;
  const multi = items.length > 1;
  const remaining = items.filter((i) => !removed.has(i.approvalId));
  const { scopes, because } = offered(remaining);
  // A request saved damaged offers no scope: it can be declined (or removed), never allowed.
  const damaged = remaining.filter((i) => !i.scopes.length);
  const canAllow = remaining.length > 0 && !damaged.length;
  const chosen = scopes.includes(scope) ? scope : "once";
  const passkey = remaining.some(needsPasskey);
  const expired = batch.expiresAt <= now;

  const submit = async (allow: boolean) => {
    if (sample) {
      setTried(true);
      return;
    }
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
    const result = await submitDecision(batch, decisions);
    setSending(false);
    // Answered, or no longer waiting after a lost answer: its receipt replaces the card.
    if (result.kind === "done" || result.kind === "handled" || result.kind === "left") return;
    setFailure(FAILURES[result.kind]);
    if (result.kind !== "not_confirmed" && result.kind !== "offline") void refreshApprovals();
  };

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const removeOrUndo = (approvalId: string) => {
    setRemoved(toggle(removed, approvalId));
    setMoved(approvalId);
  };

  const title = multi
    ? `${items.length} actions need your OK`
    : `${actionOf(items[0]?.tool ?? "")} · Needs your OK`;

  return (
    <Card
      tone="approval"
      labelledBy={where ? `${headingId} ${headingId}-in` : headingId}
      className={expired ? "opacity-60" : ""}
    >
      <CardHeader id={headingId} level={level} title={title}>
        {sample && (
          <span className="rounded-full border border-border-strong px-2 text-sm">Sample</span>
        )}
      </CardHeader>
      {multi && <p>{items.map((i) => actionOf(i.tool)).join(" · ")}</p>}
      {where && (
        <span id={`${headingId}-in`} className="sr-only">
          in {where}
        </span>
      )}
      {context}
      <p className="text-sm text-text-muted">
        {expired ? "Expired. I stopped this." : expiresIn(batch.expiresAt, now)}
      </p>
      {multi ? (
        items.map((item, n) => {
          const id = `${idPrefix}-item-${item.approvalId}`;
          const name = actionOf(item.tool);
          if (removed.has(item.approvalId)) {
            return (
              <div key={item.approvalId} className="flex flex-wrap items-center gap-2">
                <p className="text-text-muted line-through">Removed: {name}.</p>
                <p className="text-text-muted">I won't do this one.</p>
                <Button
                  id={toggleId(item.approvalId)}
                  variant="quiet"
                  isDisabled={sending}
                  onPress={() => removeOrUndo(item.approvalId)}
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
                  id={toggleId(item.approvalId)}
                  variant="quiet"
                  isDisabled={sending}
                  onPress={() => removeOrUndo(item.approvalId)}
                  aria-label={`Don't do this one: ${name}`}
                >
                  Don't do this one
                </Button>
              </CardHeader>
              {open ? (
                <ItemBody item={item} />
              ) : (
                <>
                  {item.target && <TargetLine target={item.target} />}
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
      {!expired && damaged.length > 0 && <p>{damagedText(damaged, multi)}</p>}
      {!expired && canAllow && (
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
                  {s === "destination" ? <Destinations items={remaining} /> : scopeLabel(s)}
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
      {/* Always present in a sample, so the line is announced when it appears. */}
      {sample && (
        <p role="status" className={tried ? "" : "sr-only"}>
          {tried && "That's how it works. Nothing was sent."}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
      {!expired && (
        <div className="flex flex-wrap gap-2">
          {canAllow && (
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
