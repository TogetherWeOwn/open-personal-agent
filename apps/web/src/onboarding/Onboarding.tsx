// SPDX-License-Identifier: Apache-2.0
// Onboarding v1 (M2-15): claim → about you → choose a model → Test → costs and limits → first
// chat. Everything happens here; nothing asks the user to edit a file. A saved key never comes
// back from the server, only its last 4 characters.
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
  type TestResult,
} from "../models/settings-api";
import { TestResultView } from "../models/TestResult";
import { VaultReset } from "../settings/VaultReset";
import { Button } from "../ui";

const STEPS = ["Claim", "About you", "Choose a model", "Test", "Costs and limits", "First chat"];

const field = "flex flex-col gap-1";
const input =
  "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted";
const card =
  "flex cursor-pointer flex-col gap-2 rounded-xl border border-border-strong bg-surface-raised p-4 data-selected:border-accent data-selected:ring-2 data-selected:ring-accent";

export function Onboarding() {
  const [step, setStep] = useState(1);
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

  const saveModel = run(async () => {
    const body = choice === "starter" ? { kind: "workers-ai" } : providerBody(form);
    setSettings(await api<ModelSettings>("/model", "PUT", body));
    setForm((f) => ({ ...f, apiKey: "" }));
    setTest(null);
    next();
  });

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
      <Button type="submit" isDisabled={busy} variant="primary" className="self-start">
        Continue
      </Button>
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
        onChange={(v) => setChoice(v as typeof choice)}
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
          <span className="text-sm text-text-muted">
            Starter model on Cloudflare Workers AI. It is metered: your Cloudflare account has a
            free daily allowance. Settings › Spending shows what you've used and what it costs per
            100 messages.
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
      <Button
        onPress={saveModel}
        isDisabled={busy || choice === "subscription"}
        variant="primary"
        className="self-start"
      >
        Save and continue
      </Button>
    </div>,
    <div key="test" className="flex flex-col gap-4">
      <p>
        Send one short message to <strong>{saved?.model}</strong> to check that it answers.
      </p>
      <Button
        onPress={run(async () => setTest(await api<TestResult>("/model/test", "POST")))}
        isDisabled={busy}
        className="self-start"
      >
        {busy ? "Testing…" : "Test"}
      </Button>
      {test && <TestResultView test={test} />}
      <div className="flex gap-2">
        <Button onPress={() => setStep(2)}>Change model</Button>
        <Button onPress={next} isDisabled={!test?.ok} variant="primary">
          Continue
        </Button>
      </div>
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
      <Button onPress={next} variant="primary" className="self-start">
        Got it
      </Button>
    </div>,
    <div key="chat" className="flex flex-col gap-3">
      <p>You're all set. Say hello to your assistant.</p>
      <Button
        onPress={run(async () => {
          await api("/onboarded", "POST");
          window.location.assign("/");
        })}
        isDisabled={busy}
        variant="primary"
        className="self-start"
      >
        Start chatting
      </Button>
    </div>,
  ];

  return (
    <main className="mx-auto flex max-w-[720px] flex-col gap-6 p-4">
      <h1 className="text-2xl font-semibold">Set up your assistant</h1>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
        {STEPS.map((name, i) => (
          <li
            key={name}
            aria-current={i === step ? "step" : undefined}
            className={i === step ? "font-semibold text-text" : ""}
          >
            {i < step ? "✓ " : `${i + 1}. `}
            {name}
          </li>
        ))}
      </ol>
      <Heading level={2} className="text-xl font-semibold">
        {STEPS[step]}
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
