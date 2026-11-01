// SPDX-License-Identifier: Apache-2.0
// Usage page v1 (M3-16, m3-ux §3.10): today, this month and the month-end projection, then the
// PRD §15 cost categories in order, the Cloudflare allowance meters and the breakdowns. Read like an
// account statement. The server groups, labels and sums everything (GET /api/usage); this only
// formats. `\uFE0E` keeps the ⚠ and ↗ glyphs as text, not colour emoji.
import { useCallback, useEffect, useState } from "react";
import { Heading, Label, Link, Meter } from "react-aria-components";
import { HalfBudgetLine } from "../settings/Spending";
import { dollars, getSpending, type Spending } from "../settings/spending-api";
import { Button, buttonClass, EmptyState, Page, Skeleton } from "../ui";
import { Breakdown } from "./Breakdown";
import { Meters } from "./Meters";
import { type Category, type CategoryId, dateWords, money, type UsageData } from "./usage-data";

const link = "font-medium text-accent underline underline-offset-2";

/** Each category's name and what it pays for, in the words of someone who isn't an engineer. */
const CATEGORIES: Record<CategoryId, { name: string; about: string }> = {
  "workers-paid": {
    name: "Workers Paid plan",
    about: "The Cloudflare plan your assistant runs on.",
  },
  cloudflare: {
    name: "Cloudflare services",
    about: "Requests, live chats and background tasks.",
  },
  storage: { name: "Databases and storage", about: "Your chats, memory and files." },
  ai: { name: "AI models", about: "Every message and task step. See the breakdown below." },
  computers: { name: "Computers", about: "Computers your assistant can work on." },
  connectors: {
    name: "Connectors and other services",
    about: "Paid services your assistant connects to.",
  },
  enhanced: { name: "Optional extras", about: "Add-ons you choose to turn on." },
};

const DASHBOARD = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

function Figure({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-sm text-text-muted">{term}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      {note && <dd className="text-sm text-text-muted">{note}</dd>}
    </div>
  );
}

/** This month against the monthly budget (M3-17 AC2): one meter, the budget's words beside it. */
function MonthFigure({ data, spending }: { data: UsageData; spending: Spending | null }) {
  const budget = spending?.settings.monthlyBudgetMicroUsd;
  // The budget's own month (UTC) and total, so the meter agrees with the 50% line and the banners
  // even in the hours where the local month and the UTC month differ.
  const spent = spending?.monthMicroUsd ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-text-muted">This month</dt>
      <dd className="text-2xl font-semibold tabular-nums">
        about {money(data.month.costMicroUsd, data.currency)}
      </dd>
      {budget && (
        <dd>
          <Meter
            value={Math.min(spent, budget)}
            maxValue={budget}
            valueLabel={`${Math.floor((spent / budget) * 100)}% of your ${dollars(budget)} budget`}
            className="flex flex-col gap-1"
          >
            <Label className="text-sm text-text-muted">of your {dollars(budget)} budget</Label>
            <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }}
              />
            </div>
          </Meter>
        </dd>
      )}
    </div>
  );
}

function Headline({ data, spending }: { data: UsageData; spending: Spending | null }) {
  const c = data.currency;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid gap-4 sm:grid-cols-3">
        <Figure term="Today" value={`about ${money(data.today.costMicroUsd, c)}`} />
        <MonthFigure data={data} spending={spending} />
        <Figure
          term="Projected by month-end"
          value={`about ${money(data.projected.costMicroUsd, c)}`}
          note="An estimate at this month's pace so far"
        />
      </dl>
      <p className="text-sm text-text-muted">
        AI models only. Estimated from published prices; your provider's bill is the final word.
      </p>
    </div>
  );
}

function Stale({ date }: { date: string }) {
  return (
    <span className="block text-sm text-danger">
      <span aria-hidden="true">{"\u26A0\uFE0E "}</span>Price may be out of date (checked{" "}
      {dateWords(date)})
    </span>
  );
}

function CategoryFigures({ category: k, currency }: { category: Category; currency: string }) {
  if (k.status === "none-configured")
    return <span className="text-text-muted">None configured</span>;
  if (k.status === "included") return <span>Included in Workers Paid</span>;
  if (k.status === "over-allowance")
    return (
      <span>
        {k.label}
        <span className="block text-sm text-text-muted">The amount isn't tracked here</span>
      </span>
    );
  if (k.id === "workers-paid") {
    return (
      <span className="tabular-nums">
        {money(k.month ?? 0, currency)} a month
        <span className="block text-sm text-text-muted">
          {k.label}
          {k.priceVerifiedAt && `, price as of ${dateWords(k.priceVerifiedAt)}`}
        </span>
        {k.stale && k.priceVerifiedAt && <Stale date={k.priceVerifiedAt} />}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      about {money(k.month ?? 0, currency)} this month
      <span className="block text-sm text-text-muted">
        Today about {money(k.today ?? 0, currency)} · projected about{" "}
        {money(k.projected ?? 0, currency)}
      </span>
    </span>
  );
}

function Categories({ categories, currency }: { categories: Category[]; currency: string }) {
  return (
    <section aria-labelledby="categories-heading" className="flex flex-col gap-3">
      <Heading id="categories-heading" level={2} className="text-xl font-semibold">
        Where it goes
      </Heading>
      <ol className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-raised">
        {categories.map((k) => (
          <li key={k.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 p-3">
            <span className="min-w-0 flex-1 basis-56">
              <span className="block font-medium">{CATEGORIES[k.id].name}</span>
              <span className="block text-sm text-text-muted">{CATEGORIES[k.id].about}</span>
              {k.id === "cloudflare" && (
                <Link
                  href={DASHBOARD}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${link} text-sm`}
                >
                  Check your Cloudflare dashboard <span aria-hidden="true">{"\u2197\uFE0E"}</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </Link>
              )}
            </span>
            <span className="text-left sm:text-right">
              <CategoryFigures category={k} currency={currency} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Usage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [failed, setFailed] = useState(false);
  const [spending, setSpending] = useState<Spending | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    // The zone puts each day's calls on this calendar, DST included.
    const tz = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    fetch(`/api/usage?today=${today}&month=${month}&tz=${tz}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setData, () => setFailed(true));
    getSpending().then(setSpending, () => {}); // the budget and its 50% line; Usage works without
  }, []);
  useEffect(load, [load]);

  const used = data && (data.month.groups.length > 0 || data.today.groups.length > 0);
  return (
    <Page title="Usage">
      {failed && (
        <div role="alert" className="flex flex-col items-start gap-3">
          <p>I couldn't load usage.</p>
          <Button onPress={load}>Try again</Button>
        </div>
      )}
      {!data && !failed && <Skeleton label="Loading usage" />}
      {data &&
        (used ? (
          <>
            <Headline data={data} spending={spending} />
            {spending && <HalfBudgetLine spending={spending} />}
          </>
        ) : (
          <EmptyState
            title="Nothing used yet this month"
            action={
              <Link href="/" className={buttonClass("primary")}>
                Start a chat
              </Link>
            }
          >
            Your first messages will show up here.
          </EmptyState>
        ))}
      {data && <Categories categories={data.categories} currency={data.currency} />}
      {/* The neuron line stands even when the other meters can't be read. */}
      {(data?.meters || data?.allowance) && (
        <Meters
          meters={data.meters ?? []}
          allowance={data.allowance}
          verifiedAt={data.metersVerifiedAt}
        />
      )}
      {data && used && <Breakdown data={data} />}
    </Page>
  );
}
