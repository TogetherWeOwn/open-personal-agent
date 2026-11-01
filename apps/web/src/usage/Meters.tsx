// SPDX-License-Identifier: Apache-2.0
// The Cloudflare allowance meters (M3-16 AC3, m3-ux §3.10): one per allowance the app can
// estimate, from the same list the reconciler's 70% banners read. Each says it is an estimate and
// points to the Cloudflare dashboard for the exact figure. There is no Workers-requests meter: the
// app can't count them, so the dashboard link stands in.
import { Heading, Label, Link, Meter } from "react-aria-components";
import { type AllowanceMeter, num, type UsageData } from "./usage-data";

const link = "font-medium text-accent underline underline-offset-2";
const DASHBOARD = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

/** Decimal units, as Cloudflare bills storage: 5 GB is 5,000,000,000 bytes. */
const size = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function bytes(n: number) {
  for (const [unit, scale] of [
    ["GB", 1e9],
    ["MB", 1e6],
    ["KB", 1e3],
  ] as const) {
    if (n >= scale) return `${size.format(n / scale)} ${unit}`;
  }
  return `${num.format(n)} bytes`;
}

const pct = (used: number, limit: number) => Math.floor((used / limit) * 100);

function Bar({ value, max, tick }: { value: number; max: number; tick?: number }) {
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-surface-sunken">
      <div
        className="h-full bg-accent"
        style={{ width: `${Math.min(100, (value / max) * 100)}%` }}
      />
      {tick !== undefined && (
        <div
          className="absolute inset-y-0 w-0.5 bg-text"
          style={{ left: `${(tick / max) * 100}%` }}
        />
      )}
    </div>
  );
}

interface Row {
  name: string;
  /** The words beside the bar: what is used, of what. */
  detail: string;
  used: number;
  /** The bar's end; the included amount unless a tick marks it. */
  max: number;
  included: number;
  tick?: number;
}

function rows(meters: AllowanceMeter[], allowance: UsageData["allowance"]): Row[] {
  const by = Object.fromEntries(meters.map((m) => [m.id, m]));
  const out: Row[] = [];
  const duration = by.do_duration;
  if (duration)
    out.push({
      name: "Live chats (Durable Objects)",
      detail: `${num.format(duration.used)} of ${num.format(duration.limit)} GB-s included this month`,
      used: duration.used,
      max: duration.limit,
      included: duration.limit,
    });
  const d1 = by.d1_storage;
  const cap = by.d1_cap;
  if (d1)
    out.push({
      name: "Database (D1)",
      detail: `${bytes(d1.used)} of ${bytes(d1.limit)} included${cap ? ` · limit ${bytes(cap.limit)}` : ""}`,
      used: d1.used,
      max: cap?.limit ?? d1.limit,
      included: d1.limit,
      ...(cap ? { tick: d1.limit } : {}),
    });
  const steps = by.workflows_steps;
  if (steps)
    out.push({
      name: "Background task steps (Workflows)",
      detail: `${num.format(steps.used)} of ${num.format(steps.limit)} included this month`,
      used: steps.used,
      max: steps.limit,
      included: steps.limit,
    });
  const files = by.r2_storage;
  if (files)
    out.push({
      name: "Files (R2)",
      detail: `${bytes(files.used)} of ${bytes(files.limit)} included`,
      used: files.used,
      max: files.limit,
      included: files.limit,
    });
  // Free neurons apart from billed ones (A-Co3).
  if (allowance)
    out.push({
      name: "Workers AI",
      detail: `${num.format(allowance.freeNeuronsUsed)} of ${num.format(allowance.neuronsPerDay)} free today · ${num.format(allowance.billedNeurons)} billed`,
      used: allowance.freeNeuronsUsed,
      max: allowance.neuronsPerDay,
      included: allowance.neuronsPerDay,
    });
  return out;
}

export function Meters({
  meters,
  allowance,
}: {
  meters: AllowanceMeter[];
  allowance: UsageData["allowance"];
}) {
  const reset =
    allowance && new Date(allowance.resetsAt).toLocaleTimeString(undefined, { timeStyle: "short" });
  return (
    <section aria-labelledby="meters-heading" className="flex flex-col gap-3">
      <Heading id="meters-heading" level={2} className="text-xl font-semibold">
        Cloudflare allowances
      </Heading>
      <p className="text-sm text-text-muted">
        Estimates from what your assistant records. These allowances are your whole Cloudflare
        account's, other apps included.{" "}
        <Link href={DASHBOARD} target="_blank" rel="noopener noreferrer" className={link}>
          Check your Cloudflare dashboard <span aria-hidden="true">{"\u2197\uFE0E"}</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </Link>{" "}
        for the exact figures, and for Workers requests, which aren't counted here.
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-xl border border-border bg-surface-raised">
        {rows(meters, allowance).map((r) => (
          <li key={r.name} className="p-3">
            <Meter
              value={Math.min(r.used, r.max)}
              maxValue={r.max}
              valueLabel={`${pct(r.used, r.included)}% of included, estimate`}
              className="flex flex-col gap-1"
            >
              <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                <Label className="font-medium">{r.name}</Label>
                <span className="text-sm tabular-nums">
                  {pct(r.used, r.included)}% of included{" "}
                  <span className="rounded-full border border-border px-2 text-xs text-text-muted">
                    Estimate
                  </span>
                </span>
              </span>
              <Bar value={r.used} max={r.max} {...(r.tick !== undefined ? { tick: r.tick } : {})} />
              <span className="text-sm text-text-muted tabular-nums">{r.detail}</span>
            </Meter>
          </li>
        ))}
      </ul>
      {reset && (
        <p className="text-sm text-text-muted">
          Neurons are how Cloudflare measures Workers AI work; longer messages use more. The free
          allowance resets at {reset} your time. Past it, Cloudflare bills each neuron.
        </p>
      )}
    </section>
  );
}
