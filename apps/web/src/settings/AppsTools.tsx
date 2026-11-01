// SPDX-License-Identifier: Apache-2.0
// Settings › Apps & tools (M3-19 AC1, m3-ux §3.9): the built-in tools with their risk class in
// plain words and the per-tool `{auto, ask, never}` override. The floors still apply —
// irreversible tools stay at "Asks you first" — and loosening one towards "Does it without
// asking" runs the 5-minute account step-up, then retries the change once.
import { useEffect, useState } from "react";
import { Heading, Radio, RadioGroup } from "react-aria-components";
import { settingsApi } from "../models/settings-api";
import { Button } from "../ui";
import { withAccountStepUp } from "./step-up";

import { type RiskClass, riskClassLabel, type ToolOverride, toolError } from "./tool-copy";

export interface ToolRow {
  name: string;
  description: string;
  riskClass: RiskClass;
  egress: boolean;
  override: ToolOverride;
  /** The choice an untouched tool behaves as, so the page can show the effective default. */
  default: Choice;
  locked: boolean;
}

type Choice = Exclude<ToolOverride, null>;

const CHOICES: { value: Choice; label: string }[] = [
  { value: "auto", label: "Does it without asking" },
  { value: "ask", label: "Asks you first" },
  { value: "never", label: "Never" },
];

const card = "flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4";
const hint = "text-sm text-text-muted";
const errorText = "text-sm text-danger";

export function AppsTools() {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    settingsApi<{ tools: ToolRow[] }>("/tools")
      .then(({ tools }) => {
        if (live) setTools(tools);
      })
      .catch((e) => {
        if (live) setError(toolError(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const change = async (tool: ToolRow, to: Choice | null) => {
    if (pending) return;
    setPending(tool.name);
    setError(null);
    try {
      const updated = await withAccountStepUp(() =>
        settingsApi<ToolRow>(`/tools/${tool.name}`, "PUT", { override: to }),
      );
      setTools((prev) => prev?.map((t) => (t.name === tool.name ? updated : t)) ?? null);
    } catch (e) {
      // A dismissed passkey prompt rejects here: the choice stays where it was.
      setError(toolError(e));
    } finally {
      setPending(null);
    }
  };

  if (!tools)
    return (
      <section aria-labelledby="apps-tools-heading" className="flex flex-col gap-4">
        <Heading level={2} id="apps-tools-heading" className="text-xl font-semibold">
          Apps & tools
        </Heading>
        <p className={error ? errorText : hint} role={error ? "alert" : undefined}>
          {error ?? "Loading your tools…"}
        </p>
      </section>
    );

  return (
    <section aria-labelledby="apps-tools-heading" className="flex flex-col gap-4">
      <Heading level={2} id="apps-tools-heading" className="text-xl font-semibold">
        Apps & tools
      </Heading>
      <p>
        Each tool has a default. You can tighten any tool freely; loosening one towards “Does it
        without asking” needs your passkey, and every change is written to the activity log.
      </p>
      {error && (
        <p className={errorText} role="alert">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {tools.map((tool) => (
          <li key={tool.name} className={card}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold">
                <code>{tool.name}</code>
              </p>
              <p className={hint}>
                {riskClassLabel[tool.riskClass]}
                {tool.override === null ? " · Default" : ""}
              </p>
            </div>
            <p className={hint}>{tool.description}</p>
            <RadioGroup
              aria-label={`How ${tool.name} asks you`}
              value={tool.override ?? tool.default}
              onChange={(v) => change(tool, v as Choice)}
              isDisabled={pending === tool.name}
              className="flex flex-col gap-2"
            >
              {CHOICES.map(({ value, label }) => {
                const locked = value === "auto" && tool.locked;
                // An untouched tool behaves as its default: show it selected and say so.
                const isDefault = tool.override === null && value === tool.default;
                return (
                  <div key={value}>
                    <Radio
                      value={value}
                      isDisabled={locked || pending === tool.name}
                      className="flex min-h-11 items-center gap-2"
                    >
                      {label}
                      {isDefault && <span className={hint}>(default)</span>}
                      {locked && <span className={hint}>— locked: this can't be undone</span>}
                    </Radio>
                    {value === "auto" && !locked && (
                      <p className={`${hint} pl-6`}>
                        Still asks first after reading outside content, before sending anything out,
                        or when it can't be undone.
                      </p>
                    )}
                  </div>
                );
              })}
            </RadioGroup>
            {tool.override !== null && (
              <Button
                onPress={() => change(tool, null)}
                variant="secondary"
                isDisabled={pending === tool.name}
              >
                Use the default
              </Button>
            )}
            <p className={hint}>Connectors and skills are coming later.</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
