// SPDX-License-Identifier: Apache-2.0
// Settings › Spending (M3-17 AC5, m3-ux §3.9): every limit with its default shown. The task
// budget, daily limit, monthly budget and hard limit are editable; the execution limits are
// read-only in M3. The monthly budget only warns; the hard limit pauses background tasks only.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Form, Heading, Input, Label, Link, Switch, Text, TextField } from "react-aria-components";
import { Button } from "../ui";
import {
  dollars,
  getSpending,
  parseDollars,
  SPENDING_CHANGED,
  type Spending,
  type SpendingLimits,
  saveSpending,
} from "./spending-api";

const link = "font-medium text-accent underline underline-offset-2";
const field = "flex flex-col gap-1";
const input =
  "min-h-11 w-40 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 tabular-nums";
const hint = "text-sm text-text-muted";

type Editable = Exclude<keyof SpendingLimits, "hardCapMicroUsd">;

const FIELDS: { key: Editable; label: string; about?: string }[] = [
  { key: "taskBudgetMicroUsd", label: "Task budget", about: "What one task may spend." },
  { key: "dailyCapMicroUsd", label: "Daily limit", about: "Resets at midnight UTC." },
  {
    key: "monthlyBudgetMicroUsd",
    label: "Monthly budget",
    about: "I'll warn you at 50%, 80% and 100%. I won't stop working.",
  },
];

const amount = (micro: number | null) => (micro === null ? "" : (micro / 1e6).toFixed(2));

/** The quiet 50% line, on Spending and Usage only (m3-ux §3.10). */
export function HalfBudgetLine({ spending }: { spending: Spending }) {
  if (spending.warning !== 50) return null;
  return (
    <p className={hint}>
      Half of this month's {dollars(spending.settings.monthlyBudgetMicroUsd)} budget used.
    </p>
  );
}

export function SpendingSettings() {
  const [spending, setSpending] = useState<Spending | null>(null);
  const [text, setText] = useState<Record<keyof SpendingLimits, string> | null>(null);
  const [hardOn, setHardOn] = useState(false);
  const [status, setStatus] = useState<
    "idle" | "saving" | "saved" | "saved_stale" | "failed" | "load_failed"
  >("idle");

  const show = useCallback((s: Spending) => {
    setSpending(s);
    setText({
      taskBudgetMicroUsd: amount(s.settings.taskBudgetMicroUsd),
      dailyCapMicroUsd: amount(s.settings.dailyCapMicroUsd),
      monthlyBudgetMicroUsd: amount(s.settings.monthlyBudgetMicroUsd),
      hardCapMicroUsd: amount(s.settings.hardCapMicroUsd),
    });
    setHardOn(s.settings.hardCapMicroUsd !== null);
  }, []);

  useEffect(() => {
    getSpending().then(show, () => setStatus("load_failed"));
  }, [show]);

  if (status === "load_failed") return <p role="alert">Spending couldn't be loaded. Try again.</p>;
  if (!spending || !text) return <p className={hint}>Loading…</p>;

  const parsed = Object.fromEntries(
    Object.entries(text).map(([k, v]) => [k, parseDollars(v)]),
  ) as Record<keyof SpendingLimits, number | null>;
  const invalid = (key: keyof SpendingLimits) => parsed[key] === null;
  const canSave =
    FIELDS.every(({ key }) => !invalid(key)) && (!hardOn || !invalid("hardCapMicroUsd"));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setStatus("saving");
    try {
      await saveSpending({
        taskBudgetMicroUsd: parsed.taskBudgetMicroUsd as number,
        dailyCapMicroUsd: parsed.dailyCapMicroUsd as number,
        monthlyBudgetMicroUsd: parsed.monthlyBudgetMicroUsd as number,
        hardCapMicroUsd: hardOn ? parsed.hardCapMicroUsd : null,
      });
    } catch {
      return setStatus("failed");
    }
    window.dispatchEvent(new Event(SPENDING_CHANGED));
    // Saved either way; only the figures beside the form may be a moment old.
    await getSpending().then(
      (fresh) => {
        show(fresh);
        setStatus("saved");
      },
      () => setStatus("saved_stale"),
    );
  };

  const { defaults, executionLimits: x } = spending;
  return (
    <section className="flex flex-col gap-6" aria-labelledby="spending-heading">
      <div className="flex flex-col gap-1">
        <Heading level={2} id="spending-heading" className="text-xl font-semibold">
          Spending
        </Heading>
        <p className="tabular-nums">
          This month: about {dollars(spending.monthMicroUsd)} of your{" "}
          {dollars(spending.settings.monthlyBudgetMicroUsd)} budget.{" "}
          <Link href="/usage" className={link}>
            See usage
          </Link>
        </p>
        <HalfBudgetLine spending={spending} />
      </div>
      <Form onSubmit={submit} className="flex flex-col gap-5">
        {FIELDS.map(({ key, label, about }) => (
          <TextField
            key={key}
            value={text[key]}
            onChange={(v) => setText({ ...text, [key]: v })}
            isInvalid={invalid(key)}
            className={field}
          >
            <Label className="font-medium">{label} ($)</Label>
            <Input className={input} inputMode="decimal" />
            <Text slot="description" className={hint}>
              {about} Default: {dollars(defaults[key])}.
            </Text>
            {invalid(key) && <span className="text-sm text-danger">Enter $0.01 to $10,000.</span>}
          </TextField>
        ))}
        <div className="flex flex-col gap-2">
          <Switch
            isSelected={hardOn}
            onChange={setHardOn}
            className="group flex min-h-11 items-center gap-3 font-medium"
          >
            <span
              aria-hidden="true"
              className="h-6 w-10 rounded-full bg-border-strong p-0.5 transition group-data-selected:bg-accent"
            >
              <span className="block size-5 rounded-full bg-surface transition group-data-selected:translate-x-4" />
            </span>
            Hard limit
          </Switch>
          <p className={hint}>
            Background tasks pause when this is reached. Chat and your data stay available. Default:
            off.
          </p>
          {hardOn && (
            <TextField
              value={text.hardCapMicroUsd}
              onChange={(v) => setText({ ...text, hardCapMicroUsd: v })}
              isInvalid={invalid("hardCapMicroUsd")}
              className={field}
            >
              <Label className="font-medium">Hard limit per month ($)</Label>
              <Input className={input} inputMode="decimal" />
              {invalid("hardCapMicroUsd") && (
                <span className="text-sm text-danger">Enter $0.01 to $10,000.</span>
              )}
            </TextField>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" isDisabled={!canSave || status === "saving"}>
            Save
          </Button>
          <span role="status" className={hint}>
            {status === "saved"
              ? "Saved."
              : status === "saved_stale"
                ? "Saved. Reload to see the updated figures."
                : status === "failed"
                  ? "Couldn't save. Try again."
                  : ""}
          </span>
        </div>
      </Form>
      <div className="flex flex-col gap-1">
        <Heading level={3} className="font-semibold">
          Execution limits
        </Heading>
        <p>
          Per message: {x.callsPerMessage} model calls and {x.toolCallsPerMessage} tool calls. Per
          task: {x.stepsPerTask} steps. When one is reached, I stop and you can continue.
        </p>
        <p className={hint}>These can't be changed yet.</p>
      </div>
    </section>
  );
}
