// SPDX-License-Identifier: Apache-2.0
// The app-wide spending banners (M3-17 AC2, AC4; m3-ux §3.10): 80% and 100% of the monthly
// budget, the hard limit when one is set and reached, and 70% of a Cloudflare allowance. The monthly budget never stops anything; the
// hard limit pauses background tasks only. Each can be dismissed for its own threshold; the 100%
// banner comes back the next day while the month stays over budget.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-aria-components";
import { Banner, Button, buttonClass } from "../ui";
import { dollars, getSpending, SPENDING_CHANGED, type Spending } from "./spending-api";

const RECHECK_MS = 5 * 60_000;

type Kind = "80" | "100" | "hard" | `allowance:${string}`;

/** m3-ux §3.10's allowance banner, per meter. */
const ALLOWANCES: Record<string, (percent: number) => string> = {
  d1_cap: (p) => `Your database is at ${p}% of its 10 GB limit.`,
  d1_storage: (p) => `Your database is at ${p}% of the 5 GB included in Workers Paid.`,
  r2_storage: (p) => `Your files are at ${p}% of the 10 GB of storage included in Workers Paid.`,
  workers_ai_neurons: (p) => `Workers AI is at ${p}% of today's free allowance.`,
  workflows_steps: (p) =>
    `Background tasks have used about ${p}% of this month's steps included in Workers Paid.`,
  do_duration: (p) =>
    `Live chats have used about ${p}% of this month's Durable Objects time included in Workers Paid.`,
};

/** The dismissal's key: per month and threshold, and per day for 100% and the allowances. */
function dismissKey(kind: Kind, s: Pick<Spending, "userId" | "month">) {
  const daily = kind === "100" || kind.startsWith("allowance:");
  const day = daily ? `:${new Date().toISOString().slice(0, 10)}` : "";
  // Per user, so another account signed in on the same browser never inherits a dismissal.
  return `opa.spending-banner:${s.userId}:${s.month}:${kind}${day}`;
}

function dismissed(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function SpendingBanners() {
  const [spending, setSpending] = useState<Spending | null>(null);
  const [, rerender] = useState(0);
  const load = useCallback(() => {
    getSpending().then(setSpending, () => {}); // a banner that can't load just doesn't show
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, RECHECK_MS);
    window.addEventListener("focus", load);
    window.addEventListener(SPENDING_CHANGED, load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener(SPENDING_CHANGED, load);
    };
  }, [load]);

  if (!spending) return null;
  const budget = dollars(spending.settings.monthlyBudgetMicroUsd);
  const banners: { kind: Kind; text: string; action?: "spending" | "usage" }[] = [];
  if (spending.hardCapReached && spending.settings.hardCapMicroUsd !== null) {
    const hard = dollars(spending.settings.hardCapMicroUsd);
    const text = `Background tasks are paused: this month's ${hard} hard limit is reached.`;
    banners.push({ kind: "hard", text, action: "spending" });
  }
  if (spending.warning === 100) {
    const text = `You've reached this month's ${budget} budget. I'll keep working.`;
    banners.push({ kind: "100", text, action: "spending" });
  } else if (spending.warning === 80) {
    banners.push({ kind: "80", text: `You've used 80% of this month's ${budget} budget.` });
  }
  for (const w of spending.allowanceWarnings ?? []) {
    const text = ALLOWANCES[w.id]?.(w.percent);
    if (text) banners.push({ kind: `allowance:${w.id}`, text, action: "usage" });
  }
  const shown = banners.filter((b) => !dismissed(dismissKey(b.kind, spending)));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((b) => (
        <Banner key={b.kind} tone="warning">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{b.text}</span>
            {b.action && (
              <Link
                href={b.action === "usage" ? "/usage" : "/settings/spending"}
                className={buttonClass("quiet")}
              >
                {b.action === "usage" ? "See usage" : "Open Spending"}
              </Link>
            )}
            <Button
              variant="quiet"
              aria-label="Dismiss"
              onPress={() => {
                try {
                  localStorage.setItem(dismissKey(b.kind, spending), "1");
                } catch {}
                rerender((n) => n + 1);
              }}
            >
              Dismiss
            </Button>
          </div>
        </Banner>
      ))}
    </>
  );
}
