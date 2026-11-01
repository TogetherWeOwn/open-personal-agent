// SPDX-License-Identifier: Apache-2.0
// Every kit component on one page, so the e2e suite can run axe over the tokens in both themes.
// Only the mock build (`VITE_MOCK_CHAT=1`) routes here; a real build never includes it.
import {
  Banner,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Skeleton,
  type Status,
  StatusChip,
  type Trust,
  TrustChip,
} from ".";

const STATUSES: Status[] = [
  "running",
  "waiting_for_approval",
  "budget_limited",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];
const TRUSTS: Trust[] = ["system", "user", "inferred", "external"];

export function Gallery() {
  return (
    <main className="mx-auto flex max-w-[720px] flex-col gap-6 p-4">
      <h1 className="text-2xl font-semibold">Component kit</h1>
      <Banner tone="warning">Your budget for today is 80% used.</Banner>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary">Primary</Button>
        <Button>Secondary</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="primary" isDisabled>
          Disabled
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <StatusChip key={s} status={s} />
        ))}
        <StatusChip status="budget_limited" limit />
        {TRUSTS.map((t) => (
          <TrustChip key={t} trust={t} />
        ))}
      </div>
      <Card tone="approval" labelledBy="kit-approval">
        <CardHeader id="kit-approval" level={2} title="Send an email to Sam?">
          <StatusChip status="waiting_for_approval" />
        </CardHeader>
        <p>Your assistant wants to send one email.</p>
        <Button variant="primary">Approve</Button>
      </Card>
      <Card tone="tool">
        <p>Fetched three pages.</p>
      </Card>
      <Skeleton label="Loading tasks" />
      <EmptyState title="Nothing needs you" action={<Button>Go to Chat</Button>}>
        Approvals and problems show up here.
      </EmptyState>
    </main>
  );
}
