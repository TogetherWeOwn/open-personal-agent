// SPDX-License-Identifier: Apache-2.0
// The one way to add a key (m3-ux §3.9): onboarding's model form, reused by Settings › Models
// for adding and editing a provider, so the fields and words are the same in both places.
import { Input, Label, Radio, RadioGroup, TextField } from "react-aria-components";
import type { SavedProvider } from "./settings-api";

export const PRESETS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  custom: { label: "Other OpenAI-compatible", baseUrl: "", model: "" },
} as const;
export type Preset = keyof typeof PRESETS;

export interface ProviderFormValue {
  preset: Preset;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const emptyProviderForm: ProviderFormValue = {
  preset: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
};

/** The form for a saved provider of the user's: its preset, endpoint and model; key left blank. */
export function formForProvider(row: SavedProvider): ProviderFormValue {
  const preset =
    row.providerId && row.providerId in PRESETS ? (row.providerId as Preset) : "custom";
  return {
    preset,
    baseUrl: preset === "custom" ? (row.baseUrl ?? "") : "",
    model: row.model ?? "",
    apiKey: "",
  };
}

/** The request body every save sends. An empty key field sends no key: the saved one stays. */
export function providerBody(value: ProviderFormValue) {
  const p = PRESETS[value.preset];
  return {
    kind: "openai-chat" as const,
    providerId: value.preset,
    // A base URL typed under "Other" must not follow the key to a named provider.
    baseUrl: value.preset === "custom" ? value.baseUrl : p.baseUrl,
    model: value.model || p.model,
    ...(value.apiKey ? { apiKey: value.apiKey } : {}),
  };
}

const field = "flex flex-col gap-1";
const input =
  "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted";
const presetChip =
  "flex min-h-11 items-center rounded-lg border border-border-strong px-4 font-medium data-selected:border-accent data-selected:bg-surface-raised";

interface Props {
  value: ProviderFormValue;
  onChange: (value: ProviderFormValue) => void;
  /** The saved key's last 4 when editing, so a blank key field reads as "keep it". */
  savedLast4?: string | null | undefined;
}

export function ProviderForm({ value, onChange, savedLast4 }: Props) {
  const p = PRESETS[value.preset];
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        value={value.preset}
        onChange={(preset) =>
          // A model or base URL typed for one provider never carries over to another.
          onChange({ ...value, preset: preset as Preset, baseUrl: "", model: "" })
        }
        orientation="horizontal"
        className="flex flex-wrap gap-2"
      >
        <Label className="w-full">Provider</Label>
        {Object.entries(PRESETS).map(([id, { label }]) => (
          <Radio key={id} value={id} className={presetChip}>
            {label}
          </Radio>
        ))}
      </RadioGroup>
      {value.preset === "custom" && (
        <TextField
          value={value.baseUrl}
          onChange={(baseUrl) => onChange({ ...value, baseUrl })}
          className={field}
        >
          <Label>Base URL</Label>
          <Input className={input} placeholder="https://example.com/v1" />
        </TextField>
      )}
      <TextField
        value={value.model}
        onChange={(model) => onChange({ ...value, model })}
        className={field}
      >
        <Label>Model</Label>
        <Input className={input} placeholder={p.model || "model id"} />
      </TextField>
      <TextField
        type="password"
        value={value.apiKey}
        onChange={(apiKey) => onChange({ ...value, apiKey })}
        className={field}
      >
        <Label>API key</Label>
        <Input className={input} autoComplete="off" />
        {savedLast4 !== undefined && (
          <span className="text-sm text-text-muted">
            Saved key ending in {savedLast4 ?? "····"}. Leave blank to keep it.
          </span>
        )}
      </TextField>
    </div>
  );
}
