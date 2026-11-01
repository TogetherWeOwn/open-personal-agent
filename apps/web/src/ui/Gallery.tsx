// SPDX-License-Identifier: Apache-2.0
// Every kit component on one page, so the e2e suite can run axe over the tokens in both themes.
// Only the mock build (`VITE_MOCK_CHAT=1`) routes here; a real build never includes it.
import { useState } from "react";
import { DialogTrigger } from "react-aria-components";
import {
  Banner,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  Menu,
  MenuItem,
  Sheet,
  Skeleton,
  type Status,
  StatusChip,
  Tabs,
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
  const [picked, setPicked] = useState("Nothing yet");
  const [deleted, setDeleted] = useState(false);
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
        <DialogTrigger>
          <Button variant="primary">Approve</Button>
          <ConfirmDialog
            title="Delete 4 notes?"
            confirm="Delete"
            danger
            onConfirm={() => setDeleted(true)}
          >
            <p>A backup copy is kept for 30 days, then it's gone.</p>
          </ConfirmDialog>
        </DialogTrigger>
        {deleted && <p>Deleted.</p>}
      </Card>
      <Card tone="tool">
        <Disclosure summary="Worked for 2m · 6 tools · 1 failed">
          <p>Fetched three pages.</p>
        </Disclosure>
      </Card>
      <DialogTrigger>
        <Button>Task details</Button>
        <Sheet title="Compare three pages">
          <StatusChip status="succeeded" />
        </Sheet>
      </DialogTrigger>
      <Menu label="Export">
        <MenuItem onAction={() => setPicked("Markdown")}>Markdown</MenuItem>
        <MenuItem onAction={() => setPicked("JSON")}>JSON</MenuItem>
      </Menu>
      <p>Picked: {picked}</p>
      <Tabs
        label="Usage breakdown"
        tabs={[
          { id: "day", label: "By day", content: <p>Today: about $0.12</p> },
          { id: "model", label: "By model", content: <p>gpt-4.1-mini</p> },
        ]}
      />
      <Skeleton label="Loading tasks" />
      <EmptyState title="Nothing needs you" action={<Button>Go to Chat</Button>}>
        Approvals and problems show up here.
      </EmptyState>
    </main>
  );
}
