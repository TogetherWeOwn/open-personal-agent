// SPDX-License-Identifier: Apache-2.0
// Usage page v0 (M2-21): what today's and this month's messages cost, read like an account
// statement. The server groups, labels and sums everything (GET /api/usage); this only formats.
// `\uFE0E` keeps the ⚠ and ↗ glyphs as text, not colour emoji.
import { useEffect, useState } from "react";
import {
  Heading,
  Label,
  Link,
  Meter,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { Page } from "../ui";

interface Line {
  model: string;
  name: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
  costSource: "estimated" | "reported" | null;
  priceVerifiedAt: string | null;
  stale: boolean;
}
interface Group {
  providerId: string;
  name: string;
  label: string;
  billingUrl: string | null;
  costMicroUsd: number;
  lines: Line[];
}
interface Period {
  costMicroUsd: number;
  unpricedCalls: number;
  groups: Group[];
}
interface UsageData {
  currency: string;
  today: Period;
  month: Period;
  /** Only the owner gets it: the total includes everyone's calls. */
  allowance: { neuronsPerDay: number; neuronsUsedHere: number; resetsAt: number } | null;
}

const link = "font-medium text-accent underline underline-offset-2";
const num = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/** Never shows a non-zero cost as $0.00. */
function money(micro: number, currency: string) {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency });
  return micro > 0 && micro < 10_000 ? `< ${fmt.format(0.01)}` : fmt.format(micro / 1e6);
}

function cost(line: Line, currency: string) {
  if (line.costMicroUsd === null) return "No price on file";
  const amount = money(line.costMicroUsd, currency);
  return line.costSource === "reported" ? amount : `about ${amount}`;
}

const source = (line: Line) =>
  line.costSource === "reported" ? "reported by provider" : line.costSource ? "estimated" : "";

function Stale({ line }: { line: Line }) {
  if (!line.stale || !line.priceVerifiedAt) return null;
  const day = new Date(`${line.priceVerifiedAt}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  return (
    <span className="block text-sm text-danger">
      <span aria-hidden="true">{"\u26A0\uFE0E "}</span>Price last checked {day}. It may have
      changed.
    </span>
  );
}

function ModelName({ line }: { line: Line }) {
  return (
    <>
      <span className="block font-medium">{line.name}</span>
      {line.name !== line.model && (
        <span className="block break-all text-sm text-text-muted">{line.model}</span>
      )}
      <Stale line={line} />
    </>
  );
}

function GroupSection({
  group,
  period,
  currency,
}: {
  group: Group;
  period: string;
  currency: string;
}) {
  const cell = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
  const priced = group.lines.some((l) => l.costMicroUsd !== null);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading level={2} className="text-lg font-semibold">
          {group.label}
        </Heading>
        <span className="tabular-nums">
          {priced ? `about ${money(group.costMicroUsd, currency)}` : "No price on file"}
        </span>
      </div>
      {group.billingUrl && (
        <Link
          href={group.billingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${link} self-start`}
        >
          See your bill at {group.name} <span aria-hidden="true">{"\u2197\uFE0E"}</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </Link>
      )}
      <table className="hidden w-full border-collapse sm:table">
        <caption className="sr-only">
          {group.label}, {period}
        </caption>
        <thead>
          <tr className="border-b border-border text-sm text-text-muted">
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Model
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              Messages
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              Tokens in
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              Tokens out
            </th>
            <th scope="col" className={`${cell} font-medium`}>
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {group.lines.map((line) => (
            <tr key={`${line.model}:${line.costSource}`} className="border-b border-border">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                <ModelName line={line} />
              </th>
              <td className={cell}>{num.format(line.calls)}</td>
              <td className={cell}>{compact.format(line.inputTokens)}</td>
              <td className={cell}>{compact.format(line.outputTokens)}</td>
              <td className={cell}>
                {cost(line, currency)}
                <span className="block text-sm text-text-muted">{source(line)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul aria-label={`${group.label}, ${period}`} className="flex flex-col gap-2 sm:hidden">
        {group.lines.map((line) => (
          <li
            key={`${line.model}:${line.costSource}`}
            className="rounded-xl border border-border bg-surface-raised p-3"
          >
            <ModelName line={line} />
            <span className="block tabular-nums">
              {compact.format(line.inputTokens)} in · {compact.format(line.outputTokens)} out ·{" "}
              {cost(line, currency)}
            </span>
            <span className="block text-sm text-text-muted">
              {num.format(line.calls)} {line.calls === 1 ? "message" : "messages"}
              {source(line) && `, ${source(line)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Allowance({ allowance }: { allowance: NonNullable<UsageData["allowance"]> }) {
  const { neuronsUsedHere, neuronsPerDay, resetsAt } = allowance;
  const pct = Math.min(100, Math.round((neuronsUsedHere / neuronsPerDay) * 100));
  const reset = new Date(resetsAt).toLocaleTimeString(undefined, { timeStyle: "short" });
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-raised p-4">
      <Heading level={2} className="text-lg font-semibold">
        Free Workers AI allowance
      </Heading>
      <Meter
        value={Math.min(neuronsUsedHere, neuronsPerDay)}
        maxValue={neuronsPerDay}
        valueLabel={`${pct}% used, resets at ${reset} your time`}
        className="flex flex-col gap-1"
      >
        <Label>
          Today: {num.format(neuronsUsedHere)} of {num.format(neuronsPerDay)} neurons used
        </Label>
        <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </Meter>
      <p className="text-sm text-text-muted">
        Neurons are how Cloudflare measures Workers AI work; longer messages use more. The count
        covers everyone on this assistant. The allowance is shared by your whole Cloudflare account,
        other apps included, and resets at {reset} your time.
      </p>
    </section>
  );
}

export function Usage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState<"today" | "month">("today");

  useEffect(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    fetch(`/api/usage?today=${today}&month=${month}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setData, () => setFailed(true));
  }, []);

  const period = data?.[key];
  const label = key === "today" ? "today" : "this month";
  return (
    <Page title="Usage">
      <Link href="/" className={`${link} self-start`}>
        <span aria-hidden="true">← </span>Chats
      </Link>
      {failed && <p role="alert">Usage couldn't be loaded. Try again in a moment.</p>}
      {data && period && (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-xl tabular-nums">
              Today: about {money(data.today.costMicroUsd, data.currency)} · This month: about{" "}
              {money(data.month.costMicroUsd, data.currency)}
            </p>
            <p className="text-sm text-text-muted">
              Estimated from published prices. Your provider's bill is the final word.
            </p>
          </div>
          <ToggleButtonGroup
            aria-label="Period"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[key]}
            onSelectionChange={(keys) => setKey([...keys][0] === "month" ? "month" : "today")}
            className="flex self-start rounded-lg border border-border-strong"
          >
            {(["today", "month"] as const).map((id) => (
              <ToggleButton
                key={id}
                id={id}
                className="min-h-11 rounded-lg px-4 font-medium data-selected:bg-accent data-selected:text-accent-contrast"
              >
                {id === "today" ? "Today" : "This month"}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          {data.allowance && <Allowance allowance={data.allowance} />}
          {period.unpricedCalls > 0 && (
            <p className="text-sm">
              {num.format(period.unpricedCalls)}{" "}
              {period.unpricedCalls === 1 ? "message has" : "messages have"} no price on file, so
              the total leaves them out.
            </p>
          )}
          {period.groups.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p>No usage yet. Once you chat, you'll see what each message costs here.</p>
              <Link
                href="/"
                className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 font-medium text-accent-contrast"
              >
                Start a chat
              </Link>
            </div>
          ) : (
            period.groups.map((g) => (
              <GroupSection key={g.providerId} group={g} period={label} currency={data.currency} />
            ))
          )}
        </>
      )}
    </Page>
  );
}
