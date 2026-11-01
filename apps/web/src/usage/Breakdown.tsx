// SPDX-License-Identifier: Apache-2.0
// Usage breakdowns (M3-16 AC2, m3-ux §3.10): by model (the v0 statement, the default), provider,
// conversation, task and day. By day is a bar chart with the same data as a table one toggle away
// (m3-ux §4.6), and every tab downloads as CSV.
// `\uFE0E` keeps the ⚠ and ↗ glyphs as text, not colour emoji.
import { type Key, type ReactNode, useState } from "react";
import { Heading, Link, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Button, Tabs } from "../ui";
import {
  compact,
  csvUsd,
  type Day,
  dateWords,
  type Group,
  type Line,
  messages,
  money,
  num,
  type Share,
  toCsv,
  type UsageData,
} from "./usage-data";

const link = "font-medium text-accent underline underline-offset-2";
const cell = "whitespace-nowrap px-3 py-2 text-right tabular-nums";
const head = "border-b border-border text-sm text-text-muted";
const row = "border-b border-border";

function cost(line: Line, currency: string) {
  if (line.costMicroUsd === null) return "No price on file";
  const amount = money(line.costMicroUsd, currency);
  return line.costSource === "reported" ? amount : `about ${amount}`;
}

/** "estimated, price as of Nov 1, 2026" (m3-ux §3.10: every estimate dates its price). */
function source(line: Line) {
  if (line.costSource === "reported") return "reported by provider";
  if (!line.costSource) return "";
  return line.priceVerifiedAt
    ? `estimated, price as of ${dateWords(line.priceVerifiedAt)}`
    : "estimated";
}

function Stale({ line }: { line: Line }) {
  if (!line.stale || !line.priceVerifiedAt) return null;
  return (
    <span className="block text-sm text-danger">
      <span aria-hidden="true">{"\u26A0\uFE0E "}</span>Price last checked{" "}
      {dateWords(line.priceVerifiedAt)}. It may have changed.
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

function BillLink({ group }: { group: Group }) {
  if (!group.billingUrl) return null;
  return (
    <Link
      href={group.billingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`${link} self-start`}
    >
      See your bill at {group.name} <span aria-hidden="true">{"\u2197\uFE0E"}</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </Link>
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
  const priced = group.lines.some((l) => l.costMicroUsd !== null);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading level={3} className="text-lg font-semibold">
          {group.label}
        </Heading>
        <span className="tabular-nums">
          {priced ? `about ${money(group.costMicroUsd, currency)}` : "No price on file"}
        </span>
      </div>
      <BillLink group={group} />
      <table className="hidden w-full border-collapse sm:table">
        <caption className="sr-only">
          {group.label}, {period}
        </caption>
        <thead>
          <tr className={head}>
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
            <tr key={`${line.model}:${line.costSource}`} className={row}>
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
              {messages(line.calls)}
              {source(line) && `, ${source(line)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Empty({ period }: { period: string }) {
  return <p className="text-text-muted">Nothing used {period}.</p>;
}

/** Name | Messages | Cost: three columns fit a phone, so one table serves every width. */
function SimpleTable({
  caption,
  first,
  rows,
}: {
  caption: string;
  first: string;
  rows: { key: string; name: ReactNode; calls: number; cost: string }[];
}) {
  return (
    <table className="w-full border-collapse">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className={head}>
          <th scope="col" className="px-3 py-2 text-left font-medium">
            {first}
          </th>
          <th scope="col" className={`${cell} font-medium`}>
            Messages
          </th>
          <th scope="col" className={`${cell} font-medium`}>
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={row}>
            <th scope="row" className="break-words px-3 py-2 text-left font-normal">
              {r.name}
            </th>
            <td className={cell}>{num.format(r.calls)}</td>
            <td className={cell}>{r.cost}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "about $0.12", plus how many messages had no price, so a total never hides them. */
function shareCost(s: { costMicroUsd: number; unpricedCalls: number; calls: number }, c: string) {
  if (s.unpricedCalls === s.calls) return "No price on file";
  const amount = `about ${money(s.costMicroUsd, c)}`;
  return s.unpricedCalls > 0 ? `${amount} + ${num.format(s.unpricedCalls)} unpriced` : amount;
}

const KIND = {
  conversation: {
    first: "Conversation",
    untitled: "Untitled chat",
    none: "Deleted chats and model tests",
    href: (id: string) => `/c/${encodeURIComponent(id)}`,
  },
  task: {
    first: "Task",
    untitled: "Untitled task",
    none: "Chat replies outside a task",
    href: (id: string) => `/activity/tasks/${encodeURIComponent(id)}`,
  },
};

const shareName = (s: Share, kind: keyof typeof KIND) =>
  s.id === null ? KIND[kind].none : s.title || KIND[kind].untitled;

function Shares({
  shares,
  kind,
  currency,
}: {
  shares: Share[];
  kind: keyof typeof KIND;
  currency: string;
}) {
  if (shares.length === 0) return <Empty period="this month" />;
  return (
    <SimpleTable
      caption={`By ${kind}, this month`}
      first={KIND[kind].first}
      rows={shares.map((s) => ({
        key: s.id ?? "",
        name:
          s.id === null ? (
            <span className="text-text-muted">{KIND[kind].none}</span>
          ) : (
            <Link href={KIND[kind].href(s.id)} className={link}>
              {shareName(s, kind)}
            </Link>
          ),
        calls: s.calls,
        cost: shareCost(s, currency),
      }))}
    />
  );
}

function Days({ days, currency }: { days: Day[]; currency: string }) {
  const [asTable, setAsTable] = useState(false);
  const top = Math.max(...days.map((d) => d.costMicroUsd), 0);
  const busiest = days.find((d) => d.costMicroUsd === top);
  const used = days.some((d) => d.calls > 0);
  return (
    <div className="flex flex-col gap-3">
      <ToggleButton
        isSelected={asTable}
        onChange={setAsTable}
        className="min-h-11 self-start rounded-lg border border-border-strong px-4 font-medium data-selected:bg-accent data-selected:text-accent-contrast"
      >
        Show as table
      </ToggleButton>
      {!used ? (
        <Empty period="this month" />
      ) : asTable ? (
        <SimpleTable
          caption="By day, this month"
          first="Day"
          rows={days.map((d) => ({
            key: d.date,
            name: dateWords(d.date),
            calls: d.calls,
            cost: d.calls === 0 ? money(0, currency) : shareCost(d, currency),
          }))}
        />
      ) : (
        <figure className="flex flex-col gap-2">
          {/* One image to a screen reader, named by its summary; Show as table has every day. */}
          <div
            role="img"
            aria-label={`Cost by day this month. Highest: ${
              busiest ? `${dateWords(busiest.date)}, about ${money(top, currency)}` : "none"
            }. Show as table for every day.`}
            className="flex h-40 items-end gap-px border-b border-border-strong"
          >
            {days.map((d) => (
              <div
                key={d.date}
                title={`${dateWords(d.date)}: about ${money(d.costMicroUsd, currency)}`}
                className="flex-1 rounded-t-sm bg-accent"
                style={{ height: top > 0 ? `${(d.costMicroUsd / top) * 100}%` : 0 }}
              />
            ))}
          </div>
          <figcaption className="flex justify-between text-sm text-text-muted">
            <span>{dateWords(days[0]?.date ?? "", "short")}</span>
            <span>
              Highest about {money(top, currency)}
              {busiest && `, ${dateWords(busiest.date, "short")}`}
            </span>
            <span>{dateWords(days.at(-1)?.date ?? "", "short")}</span>
          </figcaption>
        </figure>
      )}
    </div>
  );
}

/** A provider's lines summed for the By provider tab. */
const groupShare = (g: Group) => ({
  costMicroUsd: g.costMicroUsd,
  calls: g.lines.reduce((n, l) => n + l.calls, 0),
  unpricedCalls: g.lines.reduce((n, l) => n + (l.costMicroUsd === null ? l.calls : 0), 0),
});

type TabId = "model" | "provider" | "conversation" | "task" | "day";

function csvFor(tab: TabId, data: UsageData, key: "today" | "month") {
  const { breakdowns: b } = data;
  const lines = data[key].groups;
  switch (tab) {
    case "model":
      return toCsv([
        ["Billed by", "Model", "Messages", "Tokens in", "Tokens out", "Cost (USD)", "Price as of"],
        ...lines.flatMap((g) =>
          g.lines.map((l) => [
            g.name,
            l.model,
            l.calls,
            l.inputTokens,
            l.outputTokens,
            csvUsd(l.costMicroUsd),
            l.priceVerifiedAt ?? "",
          ]),
        ),
      ]);
    case "provider":
      return toCsv([
        ["Billed by", "Messages", "Cost (USD)"],
        ...lines.map((g) => [g.name, groupShare(g).calls, csvUsd(g.costMicroUsd)]),
      ]);
    case "conversation":
    case "task":
      return toCsv([
        [KIND[tab].first, "Messages", "Unpriced messages", "Cost (USD)"],
        ...b[tab].map((s) => [shareName(s, tab), s.calls, s.unpricedCalls, csvUsd(s.costMicroUsd)]),
      ]);
    case "day":
      return toCsv([
        ["Day", "Messages", "Unpriced messages", "Cost (USD)"],
        ...b.day.map((d) => [d.date, d.calls, d.unpricedCalls, csvUsd(d.costMicroUsd)]),
      ]);
  }
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function Breakdown({ data }: { data: UsageData }) {
  const [tab, setTab] = useState<TabId>("model");
  const [key, setKey] = useState<"today" | "month">("month");
  const period = data[key];
  const label = key === "today" ? "today" : "this month";
  const periodToggle = (
    <ToggleButtonGroup
      aria-label="Period"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[key]}
      onSelectionChange={(keys) => setKey([...keys][0] === "today" ? "today" : "month")}
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
  );
  const unpriced = period.unpricedCalls > 0 && (
    <p className="text-sm">
      {num.format(period.unpricedCalls)}{" "}
      {period.unpricedCalls === 1 ? "message has" : "messages have"} no price on file, so the total
      leaves {period.unpricedCalls === 1 ? "it" : "them"} out. Their cost isn't tracked here.
    </p>
  );
  const byPeriod = (body: ReactNode) => (
    <div className="flex flex-col gap-4">
      {periodToggle}
      {unpriced}
      {period.groups.length === 0 ? <Empty period={label} /> : body}
    </div>
  );
  const month = tab === "conversation" || tab === "task" || tab === "day";
  return (
    <section aria-labelledby="breakdown-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id="breakdown-heading" level={2} className="text-xl font-semibold">
          Breakdown
        </Heading>
        <Button
          onPress={() =>
            download(
              `usage-${month ? "month" : key}-by-${tab}.csv`,
              csvFor(tab, data, month ? "month" : key),
            )
          }
        >
          Export CSV
        </Button>
      </div>
      <Tabs
        label="Break down by"
        selectedKey={tab}
        onSelectionChange={(k: Key) => setTab(k as TabId)}
        tabs={[
          {
            id: "model",
            label: "Model",
            content: byPeriod(
              period.groups.map((g) => (
                <GroupSection
                  key={g.providerId}
                  group={g}
                  period={label}
                  currency={data.currency}
                />
              )),
            ),
          },
          {
            id: "provider",
            label: "Provider",
            content: byPeriod(
              <SimpleTable
                caption={`By provider, ${label}`}
                first="Billed by"
                rows={period.groups.map((g) => {
                  const share = groupShare(g);
                  return {
                    key: g.providerId,
                    name: (
                      <span className="flex flex-col gap-1">
                        {g.name}
                        <BillLink group={g} />
                      </span>
                    ),
                    calls: share.calls,
                    cost: shareCost(share, data.currency),
                  };
                })}
              />,
            ),
          },
          {
            id: "conversation",
            label: "Chat",
            content: (
              <Shares
                shares={data.breakdowns.conversation}
                kind="conversation"
                currency={data.currency}
              />
            ),
          },
          {
            id: "task",
            label: "Task",
            content: <Shares shares={data.breakdowns.task} kind="task" currency={data.currency} />,
          },
          {
            id: "day",
            label: "Day",
            content: <Days days={data.breakdowns.day} currency={data.currency} />,
          },
        ]}
      />
    </section>
  );
}
