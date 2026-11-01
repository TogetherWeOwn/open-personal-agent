// SPDX-License-Identifier: Apache-2.0
// Onboarding v1 (M2-15): claim → about you → choose a model → Test → costs and limits → first
// chat. Everything happens here; nothing asks the user to edit a file. A saved key never comes
// back from the server, only its last 4 characters.
import { type ReactNode, useEffect, useState } from "react";
import {
  Button,
  Form,
  Heading,
  Input,
  Label,
  Radio,
  RadioGroup,
  TextArea,
  TextField,
} from "react-aria-components";

const STEPS = ["Claim", "About you", "Choose a model", "Test", "Costs and limits", "First chat"];
const PRESETS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  custom: { label: "Other OpenAI-compatible", baseUrl: "", model: "" },
} as const;
type Preset = keyof typeof PRESETS;

interface Settings {
  displayName: string;
  about: string;
  model: {
    kind: "openai-chat" | "workers-ai";
    providerId: string | null;
    baseUrl: string | null;
    model: string;
    key: { last4: string | null } | null;
  } | null;
}
type TestResult =
  | { ok: true; latencyMs: number; tools: boolean; reply: string }
  | { ok: false; error: { message: string } };

const button =
  "min-h-11 rounded-lg px-4 font-medium data-disabled:opacity-50 data-pressed:opacity-90";
const primary = `${button} bg-accent text-accent-contrast`;
const secondary = `${button} border border-border-strong`;
const field = "flex flex-col gap-1";
const input =
  "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted";
const card =
  "flex cursor-pointer flex-col gap-2 rounded-xl border border-border-strong bg-surface-raised p-4 data-selected:border-accent data-selected:ring-2 data-selected:ring-accent";

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/settings${path}`, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const ERRORS: Record<string, string> = {
  key_required: "Enter the API key again: it belongs to a different provider or address.",
  invalid_base_url:
    "The base URL must be a valid https:// address, or http:// for a server on this machine.",
  vault_unavailable: "Keys can't be saved until the server's master key is fixed.",
  ai_unavailable: "Workers AI isn't connected to this deployment. Use an API key instead.",
};
const message = (e: unknown) =>
  ERRORS[(e as Error).message] ?? "That didn't work. Check the fields and try again.";

export function Onboarding() {
  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<"api-key" | "starter" | "subscription">("api-key");
  const [preset, setPreset] = useState<Preset>("openai");
  const [form, setForm] = useState({ baseUrl: "", model: "", apiKey: "" });
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    api<Settings>("").then(
      (loaded) => {
        setSettings(loaded);
        // Resume where the user left off, so an unchanged Save keeps the saved key.
        const m = loaded.model;
        if (m?.kind === "workers-ai") setChoice("starter");
        if (m?.kind !== "openai-chat") return;
        const id = m.providerId && m.providerId in PRESETS ? (m.providerId as Preset) : "custom";
        setPreset(id);
        setForm({ baseUrl: id === "custom" ? (m.baseUrl ?? "") : "", model: m.model, apiKey: "" });
      },
      () => setError("Sign in to continue setting up."),
    );
  }, []);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const next = () => setStep((s) => s + 1);
  const p = PRESETS[preset];
  const saved = settings?.model;

  const saveModel = run(async () => {
    const body =
      choice === "starter"
        ? { kind: "workers-ai" }
        : {
            kind: "openai-chat",
            providerId: preset,
            // A base URL typed under "Other" must not follow the key to a named provider.
            baseUrl: preset === "custom" ? form.baseUrl : p.baseUrl,
            model: form.model || p.model,
            ...(form.apiKey ? { apiKey: form.apiKey } : {}),
          };
    setSettings(await api<Settings>("/model", "PUT", body));
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
      <Button type="submit" isDisabled={busy} className={`${primary} self-start`}>
        Continue
      </Button>
    </Form>,
    <div key="model" className="flex flex-col gap-4">
      <RadioGroup
        aria-label="How your assistant reaches a model"
        value={choice}
        onChange={(v) => setChoice(v as typeof choice)}
        className="grid gap-3 sm:grid-cols-3"
      >
        <Radio value="api-key" className={card}>
          <span className="font-semibold">Use an API key</span>
          <span className="text-sm text-text-muted">
            Bring a key from OpenAI, OpenRouter or another OpenAI-compatible provider. It's
            encrypted on your server and never shown again.
          </span>
        </Radio>
        <Radio value="starter" className={card}>
          <span className="font-semibold">Try without a key</span>
          <span className="text-sm text-text-muted">
            Starter model on Cloudflare Workers AI. It is metered: your Cloudflare account has a
            free daily allowance. The Cloudflare dashboard shows what you've used; a Usage page here
            comes in a later release.
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
        <div className="flex flex-col gap-4">
          <RadioGroup
            value={preset}
            onChange={(v) => {
              // A model or base URL typed for one provider never carries over to another.
              setPreset(v as Preset);
              setForm((f) => ({ ...f, baseUrl: "", model: "" }));
            }}
            orientation="horizontal"
            className="flex flex-wrap gap-2"
          >
            <Label className="w-full">Provider</Label>
            {Object.entries(PRESETS).map(([id, { label }]) => (
              <Radio
                key={id}
                value={id}
                className={`${secondary} flex items-center data-selected:bg-surface-raised data-selected:border-accent`}
              >
                {label}
              </Radio>
            ))}
          </RadioGroup>
          {preset === "custom" && (
            <TextField
              value={form.baseUrl}
              onChange={(baseUrl) => setForm({ ...form, baseUrl })}
              className={field}
            >
              <Label>Base URL</Label>
              <Input className={input} placeholder="https://example.com/v1" />
            </TextField>
          )}
          <TextField
            value={form.model}
            onChange={(model) => setForm({ ...form, model })}
            className={field}
          >
            <Label>Model</Label>
            <Input className={input} placeholder={p.model || "model id"} />
          </TextField>
          <TextField
            type="password"
            value={form.apiKey}
            onChange={(apiKey) => setForm({ ...form, apiKey })}
            className={field}
          >
            <Label>API key</Label>
            <Input className={input} autoComplete="off" />
            {saved?.key && (
              <span className="text-sm text-text-muted">
                Saved key ending in {saved.key.last4 ?? "····"}. Leave blank to keep it.
              </span>
            )}
          </TextField>
        </div>
      )}
      <Button
        onPress={saveModel}
        isDisabled={busy || choice === "subscription"}
        className={`${primary} self-start`}
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
        className={`${secondary} self-start`}
      >
        {busy ? "Testing…" : "Test"}
      </Button>
      {test?.ok && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt>Latency</dt>
          <dd>{test.latencyMs} ms to the first word</dd>
          <dt>Tool calls</dt>
          <dd>{test.tools ? "Supported" : "Not supported"}</dd>
          <dt>Reply</dt>
          <dd>{test.reply || "(empty)"}</dd>
        </dl>
      )}
      {test && !test.ok && <p role="alert">The model didn't answer: {test.error.message}</p>}
      <div className="flex gap-2">
        <Button onPress={() => setStep(2)} className={secondary}>
          Change model
        </Button>
        <Button onPress={next} isDisabled={!test?.ok} className={primary}>
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
        <li>Providers also set their own rate limits; a busy model may ask you to wait.</li>
      </ul>
      <Button onPress={next} className={`${primary} self-start`}>
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
        className={`${primary} self-start`}
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
