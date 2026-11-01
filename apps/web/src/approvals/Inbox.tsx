// SPDX-License-Identifier: Apache-2.0
// The Inbox (M3-07 AC8; m3-ux §3.4): every approval waiting across conversations and tasks, each
// acted on in place with the same card as in the chat, and a link to where it came from. There is
// deliberately no "approve all". `/approvals/:approvalId` opens the chat scrolled to its card.
import { useEffect, useState } from "react";
import { Heading, Link } from "react-aria-components";
import { navigate } from "../router";
import { Button, Disclosure, EmptyState, Page, Skeleton } from "../ui";
import { ApprovalCard } from "./ApprovalCard";
import type { PendingBatch } from "./api";
import { ApprovalReceipt } from "./ItemBody";
import { refreshApprovals, useApprovals, wantFocus } from "./store";

const link = "font-medium text-accent underline underline-offset-2";
const PAGE = 20;

/** Where a request came from: its chat, through its deep link, and its task if it has one. */
function Origin({ batch }: { batch: PendingBatch }) {
  const first = batch.items[0]?.approvalId ?? "";
  return (
    <p className="flex flex-wrap gap-x-3 text-sm">
      <Link href={`/approvals/${encodeURIComponent(first)}`} className={link}>
        Open in {batch.conversationTitle || "your chat"}
      </Link>
      {batch.taskId && (
        <Link href={`/activity/tasks/${encodeURIComponent(batch.taskId)}`} className={link}>
          See the task
        </Link>
      )}
    </p>
  );
}

const startOfToday = () => new Date().setHours(0, 0, 0, 0);

export function Inbox() {
  const { status, batches, receipts, announcement } = useApprovals();
  const [all, setAll] = useState(false);
  useEffect(() => {
    void refreshApprovals();
  }, []);
  const today = receipts.filter((r) => r.at >= startOfToday());
  const shown = all ? batches : batches.slice(0, PAGE);
  return (
    <Page title="Inbox">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {status === "loading" && <Skeleton label="Loading your inbox" />}
      {status === "error" && (
        <EmptyState
          title="I couldn't load your inbox."
          action={<Button onPress={() => void refreshApprovals()}>Try again</Button>}
        />
      )}
      {status === "ready" && !batches.length && (
        <EmptyState
          title="Nothing needs you right now."
          action={
            <Link href="/activity" className={link}>
              See Activity
            </Link>
          }
        />
      )}
      {batches.length > 0 && (
        <section aria-labelledby="inbox-ok" className="flex flex-col gap-4">
          <Heading id="inbox-ok" level={2} className="text-lg font-semibold">
            Needs your OK ({batches.length})
          </Heading>
          {shown.map((b) => (
            <ApprovalCard
              key={b.batchId}
              batch={b}
              context={<Origin batch={b} />}
              where={b.conversationTitle || "your chat"}
            />
          ))}
          {!all && batches.length > PAGE && (
            <Button className="self-start" onPress={() => setAll(true)}>
              Show all {batches.length}
            </Button>
          )}
        </section>
      )}
      {today.length > 0 && (
        <section aria-label="Done today">
          <Disclosure summary={`Done today (${today.length})`}>
            <div className="flex flex-col gap-2">
              {today.map((r) => (
                <ApprovalReceipt key={r.batch.batchId} receipt={r} />
              ))}
            </div>
          </Disclosure>
        </section>
      )}
    </Page>
  );
}

/**
 * `/approvals/:approvalId`: the chat it belongs to, scrolled to its card. A request that no
 * longer waits (answered, expired, its task stopped, or not this user's) says so instead.
 */
export function ApprovalLink({ params }: { params: Record<string, string> }) {
  const { status, batches } = useApprovals();
  const id = params.approvalId ?? "";
  const batch = batches.find((b) => b.items.some((i) => i.approvalId === id));
  useEffect(() => {
    void refreshApprovals();
  }, []);
  useEffect(() => {
    if (!batch) return;
    wantFocus(batch.batchId);
    navigate(`/c/${encodeURIComponent(batch.conversationId)}`, true);
  }, [batch]);
  if (batch || status === "loading") return <Skeleton label="Opening the request" />;
  if (status === "error") {
    return (
      <Page title="Inbox">
        <EmptyState
          title="I couldn't load this request."
          action={<Button onPress={() => void refreshApprovals()}>Try again</Button>}
        />
      </Page>
    );
  }
  return (
    <Page title="This request isn't waiting anymore">
      <p>
        It was answered, it expired, or its task was stopped.{" "}
        <Link href="/inbox" className={link}>
          Go to your Inbox
        </Link>
      </p>
    </Page>
  );
}
