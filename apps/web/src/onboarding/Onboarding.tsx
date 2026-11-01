// SPDX-License-Identifier: Apache-2.0
// Onboarding v2 (M3-24 AC1, m3-ux §3.12): claim → about you → choose a model, tested in the same
// step → costs and limits → safety → first chat. Everything happens here; nothing asks the user to
// edit a file. A saved key never comes back from the server, only its last 4 characters. Every
// step but Claim and the model can be skipped, and a skipped one waits on the setup checklist.
import type { SetupStep } from "@opa/core";
import { type ReactNode, useEffect, useState } from "react";
import {
  Form,
  Heading,
  Input,
  Label,
  Radio,
  RadioGroup,
  TextArea,
  TextField,
} from "react-aria-components";
import {
  PRESETS,
  type Preset,
  ProviderForm,
  type ProviderFormValue,
  providerBody,
} from "../models/ProviderForm";
import {
  settingsApi as api,
  type ModelSettings,
  settingsError as message,
  needsVaultReset,
  STARTER_LABEL,
  type TestResult,
} from "../models/settings-api";
import { TestResultView } from "../models/TestResult";
import { dollars, getSpending, parseDollars, saveSpending } from "../settings/spending-api";
import { VaultReset } from "../settings/VaultReset";
import { Button } from "../ui";
import { setPrefill } from "./prefill";
import { SafetyExplainer } from "./Safety";
import { SuggestedPrompts } from "./Suggestions";

const STEPS: { name: string; skip?: SetupStep }[] = [
  { name: "Claim" },
  { name: "About you", skip: "about" },
  { name: "Choose a model" },
  { name: "Costs and limits", skip: "costs" },
  { name: "Safety", skip: "safety" },
  { name: "First chat", skip: "chat" },
];

const field = "flex flex-col gap-1";
const input =
  "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted";
const card =
  "flex cursor-pointer flex-col gap-2 rounded-xl border border-border-strong bg-surface-raised p-4 data-selected:border-accent data-selected:ring-2 data-selected:ring-accent";

type Budget = "taskBudgetMicroUsd" | "monthlyBudgetMicroUsd";
const BUDGETS: { key: Budget; label: string; fallback: number }[] = [
  { key: "taskBudgetMicroUsd", label: "Task budget", fallback: 500_000 },
  { key: "monthlyBudgetMicroUsd", label: "Monthly budget", fallback: 20_000_000 },
];

export function Onboarding() {
  const [step, setStep] = useState(1);
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<"api-key" | "starter" | "subscription">("api-key");
  const [form, setForm] = useState<ProviderFormValue>({
    preset: "openai",
    baseUrl: "",
    model: "",
    apiKey: "",
  });
  const [test, setTest] = useState<TestResult | null>(null);
  // The save came back `vault_reset_required`: the saved keys don't open, so offer the reset.
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState("");
  // The budgets as saved (their defaults until changed), and the ones the user is changing.
  const [budgets, setBudgets] = useState<Record<Budget, number> | null>(null);
  const [editing, setEditing] = useState<Partial<Record<Budget, string>>>({});

  useEffect(() => {
    api<ModelSettings>("").then(
      (loaded) => {
        setSettings(loaded);
        // Resume where the user left off, so an unchanged Save keeps the saved key.
        const m = loaded.model;
        if (m?.kind === "workers-ai") setChoice("starter");
        if (m?.kind !== "openai-chat") return;
        const id = m.providerId && m.providerId in PRESETS ? (m.providerId as Preset) : "custom";
        setForm({
          preset: id,
          baseUrl: id === "custom" ? (m.baseUrl ?? "") : "",
          model: m.model,
          apiKey: "",
        });
      },
      () => setError("Sign in to continue setting up."),
    );
    getSpending().then(
      ({ settings: s }) =>
        setBudgets({
          taskBudgetMicroUsd: s.taskBudgetMicroUsd,
          monthlyBudgetMicroUsd: s.monthlyBudgetMicroUsd,
        }),
      () => {},
    );
  }, []);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      if (needsVaultReset(e)) setLocked(true);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const next = () => setStep((s) => s + 1);
  const saved = settings?.model;

  /** Leaves for the chat, with a picked prompt waiting in its composer, or for `to`. */
  const finish = async (prompt?: string, to = "/") => {
    await api("/onboarded", "POST");
    if (prompt) setPrefill(prompt);
    window.location.assign(to);
  };

  const skip = run(async () => {
    const id = STEPS[step]?.skip;
    if (!id) return;
    await api("/setup", "POST", { skip: id });
    setSkipped((s) => new Set(s).add(step));
    if (step === STEPS.length - 1) await finish();
    else next();
  });
  const skipButton = (
    <Button variant="quiet" onPress={skip} isDisabled={busy}>
      Skip for now
    </Button>
  );
  const actions = (...primary: ReactNode[]) => (
    <div className="flex flex-wrap items-center gap-2">
      {primary}
      {skipButton}
    </div>
  );

  const saveAndTest = run(async () => {
    setTest(null);
    const body = choice === "starter" ? { kind: "workers-ai" } : providerBody(form);
    setSettings(await api<ModelSettings>("/model", "PUT", body));
    setForm((f) => ({ ...f, apiKey: "" }));
    setTest(await api<TestResult>("/model/test", "POST"));
  });

  const saveBudgets = () => {
    const changes: Partial<Record<Budget, number>> = {};
    for (const { key, label } of BUDGETS) {
      const typed = editing[key];
      if (typed === undefined) continue;
      const micro = parseDollars(typed);
      if (micro === null) {
        setError(`${label}: enter an amount from $0.01 to $10,000.`);
        return;
      }
      changes[key] = micro;
    }
    run(async () => {
      if (Object.keys(changes).length) await saveSpending(changes);
      next();
    })();
  };

  const screens: ReactNode[] = [
    null,
    <Form
      key="about"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.currentTarget));
        run(async () => {
          await api("/profile", "PUT", data);
          next();
        })();
      }}
    >
      <TextField
        name="displayName"
        isRequired
        defaultValue={settings?.displayName ?? ""}
        className={field}
      >
        <Label>What should your assistant call you?</Label>
        <Input className={input} maxLength={80} />
      </TextField>
      <TextField name="about" defaultValue={settings?.about ?? ""} className={field}>
        <Label>Anything it should know about you? (optional)</Label>
        <TextArea className={input} rows={3} maxLength={2000} />
      </TextField>
      {actions(
        <Button key="go" type="submit" isDisabled={busy} variant="primary">
          Continue
        </Button>,
      )}
    </Form>,
    <div key="model" className="flex flex-col gap-4">
      {locked && (
        <VaultReset
          onReset={async () => {
            setLocked(false);
            setError("");
            setNotice("Your saved keys were deleted. Enter your API key again.");
            // The saved key is gone, so the form stops offering to keep it.
            setSettings(await api<ModelSettings>(""));
          }}
          onRefresh={async () => {
            setLocked(false);
            setError("");
            setNotice("Your saved keys open again. Nothing was deleted. Save again to continue.");
            setSettings(await api<ModelSettings>(""));
          }}
        />
      )}
      {notice && <p role="status">{notice}</p>}
      <RadioGroup
        aria-label="How your assistant reaches a model"
        value={choice}
        onChange={(v) => {
          setChoice(v as typeof choice);
          setTest(null);
        }}
        className="grid gap-3 sm:grid-cols-3"
      >
        <Radio value="api-key" className={card}>
          <span className="font-semibold">Use an API key</span>
          <span className="text-sm text-text-muted">
            Bring a key from OpenAI, Anthropic, OpenRouter or another OpenAI-compatible provider.
            It's encrypted on your server and never shown again.
          </span>
        </Radio>
        <Radio value="starter" className={card}>
          <span className="font-semibold">Try without a key</span>
          <span className="text-sm font-medium">{STARTER_LABEL}</span>
          <span className="text-sm text-text-muted">
            Starter model on Cloudflare Workers AI. It is metered: your Cloudflare account has a
            free daily allowance. Usage shows what you've used, and Settings › Models what it costs
            per 100 messages.
          </span>
        </Radio>
        <Radio value="subscription" className={card}>
          <span className="font-semibold">I have a subscription</span>
          <span className="text-sm text-text-muted">
            A ChatGPT or Claude subscription isn't an API key, so it can't be used here directly.
            Use an API key or the starter for now.
          </span>
        </Radio>
      </RadioGroup>
      {choice === "api-key" && (
        <ProviderForm
          value={form}
          onChange={setForm}
          savedLast4={saved?.key ? saved.key.last4 : undefined}
        />
      )}
      <p className="text-sm text-text-muted">
        Saving sends one short message to the model to check that it answers.
      </p>
      <Button
        onPress={saveAndTest}
        isDisabled={busy || choice === "subscription"}
        className="self-start"
      >
        {busy ? "Testing…" : "Save and test"}
      </Button>
      {test && <TestResultView test={test} />}
      <Button onPress={next} isDisabled={!test?.ok} variant="primary" className="self-start">
        Continue
      </Button>
    </div>,
    <div key="costs" className="flex flex-col gap-3">
      <p>Your assistant runs on your own Cloudflare account, so the bills come to you directly:</p>
      <ul className="list-disc pl-6">
        <li>With an API key, your model provider charges you for every message.</li>
        <li>
          Workers AI is metered. Cloudflare includes a free daily allowance, and your Cloudflare
          dashboard shows how much of it you've used.
        </li>
        <li>
          To keep a runaway bill from happening, chat pauses for the day once you've spent $5 at
          published prices. It starts again at midnight UTC. Models without a published price, such
          as local models, aren't counted toward this limit.
        </li>
        <li>Providers also set their own rate limits; a busy model may ask you to wait.</li>
      </ul>
      <p>I also start with these budgets:</p>
      <ul className="flex flex-col gap-2">
        {BUDGETS.map(({ key, label, fallback }) => {
          const value = budgets?.[key] ?? fallback;
          const typed = editing[key];
          return (
            <li key={key} className="flex flex-wrap items-end gap-2">
              {typed === undefined ? (
                <>
                  <span>
                    {label}: <strong>{dollars(value)}</strong>
                    {key === "monthlyBudgetMicroUsd" ? " (I warn you; I don't stop)" : " per task"}
                  </span>
                  <Button
                    variant="quiet"
                    aria-label={`Change ${label.toLowerCase()}`}
                    onPress={() => setEditing((e) => ({ ...e, [key]: (value / 1e6).toFixed(2) }))}
                  >
                    Change
                  </Button>
                </>
              ) : (
                <TextField
                  value={typed}
                  onChange={(v) => setEditing((e) => ({ ...e, [key]: v }))}
                  className={field}
                >
                  <Label>{label} ($)</Label>
                  <Input className={`${input} w-40 tabular-nums`} inputMode="decimal" />
                </TextField>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-text-muted">
        You can change these any time in Settings › Spending.
      </p>
      {actions(
        <Button key="go" onPress={saveBudgets} isDisabled={busy} variant="primary">
          Continue
        </Button>,
      )}
    </div>,
    <div key="safety" className="flex flex-col gap-4">
      <SafetyExplainer />
      {actions(
        <Button key="go" onPress={next} variant="primary">
          Continue
        </Button>,
        <Button
          key="change"
          isDisabled={busy}
          onPress={run(async () => {
            // Leaving here skips the first chat, so it waits on the checklist.
            await api("/setup", "POST", { skip: "chat" });
            await finish(undefined, "/settings/apps");
          })}
        >
          Change what needs my OK
        </Button>,
      )}
    </div>,
    <div key="chat" className="flex flex-col gap-4">
      <p>You're all set. Try one of these:</p>
      <SuggestedPrompts isDisabled={busy} onPick={(prompt) => run(() => finish(prompt))()} />
      {actions(
        <Button key="go" onPress={run(() => finish())} isDisabled={busy} variant="primary">
          Start chatting
        </Button>,
      )}
    </div>,
  ];

  return (
    <main className="mx-auto flex max-w-[720px] flex-col gap-6 p-4">
      <h1 className="text-2xl font-semibold">Set up your assistant</h1>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
        {STEPS.map(({ name }, i) => (
          <li
            key={name}
            aria-current={i === step ? "step" : undefined}
            className={i === step ? "font-semibold text-text" : ""}
          >
            {i >= step ? `${i + 1}. ${name}` : skipped.has(i) ? `${name} – Skipped` : `✓ ${name}`}
          </li>
        ))}
      </ol>
      <Heading level={2} className="text-xl font-semibold">
        {step === 4 ? "How I ask before acting" : STEPS[step]?.name}
      </Heading>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {settings && screens[step]}
    </main>
  );
}
