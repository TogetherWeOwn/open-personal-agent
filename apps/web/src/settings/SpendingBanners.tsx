// SPDX-License-Identifier: Apache-2.0
// The app-wide spending banners (M3-17 AC2, m3-ux §3.10): 80% and 100% of the monthly budget,
// and the hard limit when one is set and reached. The monthly budget never stops anything; the
// hard limit pauses background tasks only. Each can be dismissed for its own threshold; the 100%
// banner comes back the next day while the month stays over budget.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-aria-components";
import { Banner, Button, buttonClass } from "../ui";
import { dollars, getSpending, type Spending } from "./spending-api";

const RECHECK_MS = 5 * 60_000;

/** The dismissal's key: per month and threshold, and per day for the 100% banner. */
function dismissKey(kind: "80" | "100" | "hard", month: number) {
  const day = kind === "100" ? `:${new Date().toISOString().slice(0, 10)}` : "";
  return `opa.spending-banner:${month}:${kind}${day}`;
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
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  if (!spending) return null;
  const budget = dollars(spending.settings.monthlyBudgetMicroUsd);
  const banners: { kind: "80" | "100" | "hard"; text: string; action: boolean }[] = [];
  if (spending.hardCapReached && spending.settings.hardCapMicroUsd !== null) {
    const hard = dollars(spending.settings.hardCapMicroUsd);
    const text = `Background tasks are paused: this month's ${hard} hard limit is reached.`;
    banners.push({ kind: "hard", text, action: true });
  }
  if (spending.warning === 100) {
    const text = `You've reached this month's ${budget} budget. I'll keep working.`;
    banners.push({ kind: "100", text, action: true });
  } else if (spending.warning === 80) {
    banners.push({
      kind: "80",
      text: `You've used 80% of this month's ${budget} budget.`,
      action: false,
    });
  }
  const shown = banners.filter((b) => !dismissed(dismissKey(b.kind, spending.month)));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((b) => (
        <Banner key={b.kind} tone="warning">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{b.text}</span>
            {b.action && (
              <Link href="/settings/spending" className={buttonClass("quiet")}>
                Open Spending
              </Link>
            )}
            <Button
              variant="quiet"
              aria-label="Dismiss"
              onPress={() => {
                try {
                  localStorage.setItem(dismissKey(b.kind, spending.month), "1");
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
