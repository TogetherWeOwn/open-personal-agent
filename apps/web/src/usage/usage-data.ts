// SPDX-License-Identifier: Apache-2.0
// What GET /api/usage sends (M2-21, M3-16) and the few ways the page formats it. The server
// groups, labels, sums and projects; nothing here adds up a cost.

export interface Line {
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
export interface Group {
  providerId: string;
  name: string;
  label: string;
  billingUrl: string | null;
  costMicroUsd: number;
  lines: Line[];
}
export interface Period {
  costMicroUsd: number;
  unpricedCalls: number;
  groups: Group[];
}
export type CategoryId =
  | "workers-paid"
  | "cloudflare"
  | "storage"
  | "ai"
  | "computers"
  | "connectors"
  | "enhanced";
export interface Category {
  id: CategoryId;
  /** "over-allowance": a Cloudflare meter passed the included amount; the excess cost is unknown. */
  status: "billed" | "included" | "over-allowance" | "none-configured";
  label: string | null;
  today?: number | null;
  month?: number;
  projected?: number;
  priceVerifiedAt?: string;
  stale?: boolean;
}
/** A month's calls in one conversation or task; a null ID is deleted, or outside one. */
export interface Share {
  id: string | null;
  title: string | null;
  calls: number;
  costMicroUsd: number;
  unpricedCalls: number;
}
export interface Day {
  /** The local date, YYYY-MM-DD. */
  date: string;
  calls: number;
  costMicroUsd: number;
  unpricedCalls: number;
}
/** One Cloudflare allowance, as the reconciler's banners read it (M3-16 AC3). */
export interface AllowanceMeter {
  id:
    | "d1_cap"
    | "d1_storage"
    | "r2_storage"
    | "workers_ai_neurons"
    | "workflows_steps"
    | "do_duration";
  used: number;
  limit: number;
  unit: "bytes" | "neurons" | "steps" | "gb_seconds";
}
export interface UsageData {
  currency: string;
  today: Period;
  month: Period;
  projected: { costMicroUsd: number };
  categories: Category[];
  breakdowns: { conversation: Share[]; task: Share[]; day: Day[] };
  /** Only the owner gets it: the total includes everyone's calls. */
  allowance: {
    neuronsPerDay: number;
    neuronsUsedHere: number;
    freeNeuronsUsed: number;
    billedNeurons: number;
    resetsAt: number;
  } | null;
  /** Only the owner gets them: the allowances are the Cloudflare account's. */
  meters: AllowanceMeter[] | null;
  /** When the included amounts were checked; null with the meters. */
  metersVerifiedAt: string | null;
}

export const num = new Intl.NumberFormat();
export const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Never shows a non-zero cost as $0.00. */
export function money(micro: number, currency: string) {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency });
  return micro > 0 && micro < 10_000 ? `< ${fmt.format(0.01)}` : fmt.format(micro / 1e6);
}

/** A YYYY-MM-DD as words, read in UTC so it never shifts a day: "Nov 1, 2026". */
export const dateWords = (date: string, style: "medium" | "short" = "medium") =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(
    undefined,
    style === "medium"
      ? { dateStyle: "medium", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" },
  );

export const messages = (n: number) => `${num.format(n)} ${n === 1 ? "message" : "messages"}`;

/**
 * Rows as CSV. A cell that a spreadsheet would run as a formula (a conversation title can be
 * anything) gets a leading apostrophe, so opening the file never runs it.
 */
export function toCsv(rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const s = typeof v === "number" ? String(v) : /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** Costs in CSV are plain US dollars to six places: the ledger's micro-dollars. */
export const csvUsd = (micro: number | null) => (micro === null ? "" : (micro / 1e6).toFixed(6));
