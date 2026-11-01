// SPDX-License-Identifier: Apache-2.0
// Settings › Models (M3-06b; m3-ux §3.9): several providers, each shown with its key's last 4
// characters and its dates — a saved key is never shown again (SEC-7). The Chat and Background
// roles pick from the saved providers; adding a key uses onboarding's form, so there is one way.
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Heading,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import {
  emptyProviderForm,
  formForProvider,
  ProviderForm,
  type ProviderFormValue,
  providerBody,
} from "../models/ProviderForm";
import {
  dayOf,
  describePick,
  type ModelSettings,
  per100Messages,
  priceChecked,
  type SavedProvider,
  settingsApi,
  settingsError,
  type TestResult,
} from "../models/settings-api";
import { TestResultView } from "../models/TestResult";

const button =
  "min-h-11 rounded-lg px-4 font-medium data-disabled:opacity-50 data-pressed:opacity-90";
const primary = `${button} bg-accent text-accent-contrast`;
const secondary = `${button} border border-border-strong`;
const selectButton =
  "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-left data-disabled:opacity-50";
const option =
  "cursor-pointer rounded-lg px-3 py-2 data-focused:bg-surface-sunken data-selected:font-semibold";
const cardClass = "flex flex-col gap-3 rounded-xl border border-border bg-surface-raised p-4";

/** "{modelName} · {providerName}", with the model id under it when the two differ. */
function ModelLabel({ row }: { row: SavedProvider }) {
  return (
    <>
      <span className="block font-medium">
        {row.modelName ?? row.model} · {row.providerName}
      </span>
      {row.modelName && row.modelName !== row.model && (
        <span className="block break-all text-sm text-text-muted">{row.model}</span>
      )}
    </>
  );
}

function priceLine(row: SavedProvider): string {
  const per100 = per100Messages(row.price);
  return per100 && row.price ? `${per100} (${priceChecked(row.price)})` : "No price on file";
}

interface CardProps {
  row: SavedProvider;
  badges: string[];
  isChat: boolean;
  onChanged: (announcement: string) => Promise<void>;
}

/** One saved provider: what it is, its key's dates, and Test / Edit / Remove. */
function ProviderCard({ row, badges, isChat, onChanged }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [editing, setEditing] = useState<ProviderFormValue | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(settingsError(e));
    } finally {
      setBusy(false);
    }
  };

  const name = `${row.modelName ?? row.model} · ${row.providerName}`;
  return (
    <li className={cardClass}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <ModelLabel row={row} />
          {badges.length > 0 && <p className="text-sm text-text-muted">{badges.join(" · ")}</p>}
        </div>
      </div>
      {row.key ? (
        <p className="text-sm">
          Key ending in {row.key.last4 ?? "····"} · added {dayOf(row.key.createdAt)} ·{" "}
          {row.key.lastUsedAt ? `last used ${dayOf(row.key.lastUsedAt)}` : "never used yet"}
        </p>
      ) : (
        <p className="text-sm">No key needed — it runs on your Cloudflare account.</p>
      )}
      <p className="text-sm text-text-muted">{priceLine(row)}</p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {editing ? (
        <div className="flex flex-col gap-4">
          <ProviderForm
            value={editing}
            onChange={setEditing}
            savedLast4={row.key ? row.key.last4 : undefined}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              className={primary}
              isDisabled={busy}
              onPress={() =>
                void run(async () => {
                  await settingsApi(`/providers/${row.id}`, "PUT", providerBody(editing));
                  setEditing(null);
                  setTest(null);
                  await onChanged(`${name} saved.`);
                })
              }
            >
              Save
            </Button>
            <Button className={secondary} isDisabled={busy} onPress={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : confirmingRemove ? (
        <div className="flex flex-col gap-3">
          <p>Remove {name}? Its key is deleted, and chats using it go back to your chat model.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              className={primary}
              isDisabled={busy}
              onPress={() =>
                void run(async () => {
                  await settingsApi(`/providers/${row.id}`, "DELETE");
                  await onChanged(`${name} removed.`);
                })
              }
            >
              Remove
            </Button>
            <Button
              className={secondary}
              isDisabled={busy}
              onPress={() => setConfirmingRemove(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            className={secondary}
            isDisabled={busy}
            aria-label={`Test ${name}`}
            onPress={() =>
              void run(async () =>
                setTest(await settingsApi<TestResult>(`/providers/${row.id}/test`, "POST", {})),
              )
            }
          >
            {busy ? "Testing…" : "Test"}
          </Button>
          {row.kind !== "workers-ai" && (
            <Button
              className={secondary}
              isDisabled={busy}
              aria-label={`Edit ${name}`}
              onPress={() => setEditing(formForProvider(row))}
            >
              Edit
            </Button>
          )}
          <Button
            className={secondary}
            isDisabled={busy}
            aria-label={`Remove ${name}`}
            onPress={() =>
              isChat
                ? setError(
                    "This provider is your chat model. Choose a different chat model first, then remove it.",
                  )
                : setConfirmingRemove(true)
            }
          >
            Remove
          </Button>
        </div>
      )}
      {test && <TestResultView test={test} />}
    </li>
  );
}

interface RoleSelectProps {
  label: string;
  description: string;
  value: string;
  onChange: (providerId: string) => void;
  providers: SavedProvider[];
  /** The extra "automatic" choice's label, for Background; its value is "". */
  automaticLabel?: string;
  isDisabled?: boolean;
}

function RoleSelect({
  label,
  description,
  value,
  onChange,
  providers,
  automaticLabel,
  isDisabled,
}: RoleSelectProps) {
  return (
    <Select
      selectedKey={automaticLabel && value === "" ? "automatic" : value}
      onSelectionChange={(key) => onChange(key === "automatic" ? "" : String(key ?? ""))}
      isDisabled={!!isDisabled}
      placeholder="Choose a model"
      className="flex max-w-md flex-col gap-1"
    >
      <Label>{label}</Label>
      <Button className={selectButton}>
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </Button>
      <p className="text-sm text-text-muted">{description}</p>
      <Popover className="w-(--trigger-width) rounded-xl border border-border-strong bg-surface-raised p-1 shadow-lg">
        <ListBox>
          {automaticLabel && (
            <ListBoxItem id="automatic" textValue={automaticLabel} className={option}>
              {automaticLabel}
            </ListBoxItem>
          )}
          {providers.map((row) => (
            <ListBoxItem
              key={row.id}
              id={row.id}
              textValue={`${row.modelName ?? row.model} · ${row.providerName}`}
              className={option}
            >
              <ModelLabel row={row} />
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function ModelsSettings() {
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [roleError, setRoleError] = useState("");
  const [roleBusy, setRoleBusy] = useState(false);
  const [addForm, setAddForm] = useState<ProviderFormValue>(emptyProviderForm);
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const load = useCallback(async () => {
    setSettings(await settingsApi<ModelSettings>(""));
  }, []);

  useEffect(() => {
    load().catch(() => setFailed(true));
  }, [load]);

  /** Reloads after a change and says so, politely. */
  const changed = useCallback(
    async (text: string) => {
      await load();
      setAnnouncement(text);
    },
    [load],
  );

  const saveRole = async (body: unknown, text: string) => {
    setRoleBusy(true);
    setRoleError("");
    try {
      setSettings(await settingsApi<ModelSettings>("/roles", "PUT", body));
      setAnnouncement(text);
    } catch (e) {
      setRoleError(settingsError(e));
    } finally {
      setRoleBusy(false);
    }
  };

  const add = async (fn: () => Promise<void>, text: string) => {
    setAddBusy(true);
    setAddError("");
    try {
      await fn();
      setAddForm(emptyProviderForm);
      await changed(text);
    } catch (e) {
      setAddError(settingsError(e));
    } finally {
      setAddBusy(false);
    }
  };

  if (failed) {
    return (
      <section className="flex flex-col items-start gap-3" aria-labelledby="models-heading">
        <Heading level={2} id="models-heading" className="text-xl font-semibold">
          Models
        </Heading>
        <p role="alert">Your model settings couldn't be loaded. Try again in a moment.</p>
        <Button
          className={secondary}
          onPress={() => {
            setFailed(false);
            load().catch(() => setFailed(true));
          }}
        >
          Try again
        </Button>
      </section>
    );
  }
  if (!settings) {
    return (
      <section aria-labelledby="models-heading" className="flex flex-col gap-4">
        <Heading level={2} id="models-heading" className="text-xl font-semibold">
          Models
        </Heading>
        <p role="status">Loading your models…</p>
      </section>
    );
  }

  const { providers, roles } = settings;
  const hasStarter = providers.some((p) => p.kind === "workers-ai");
  const backgroundNow = roles.background ? describePick(settings, roles.background) : null;

  return (
    <section className="flex flex-col gap-8" aria-labelledby="models-heading">
      <div className="flex flex-col gap-2">
        <Heading level={2} id="models-heading" className="text-xl font-semibold">
          Models
        </Heading>
        <p>
          Your assistant sends your messages to a model provider to get replies. Keys are encrypted
          on your server and never shown again — only their last 4 characters.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <Heading level={3} className="text-lg font-semibold">
          Your models
        </Heading>
        {roleError && (
          <p role="alert" className="text-danger">
            {roleError}
          </p>
        )}
        {providers.length === 0 ? (
          <p>No model set up yet. Add a provider below, then choose it here.</p>
        ) : (
          <>
            <RoleSelect
              label="Chat model"
              description="The model your chats use, unless a chat has its own."
              value={roles.chat?.provider ?? ""}
              providers={providers}
              isDisabled={roleBusy}
              onChange={(provider) => void saveRole({ chat: { provider } }, "Chat model saved.")}
            />
            <RoleSelect
              label="Background model"
              description={
                backgroundNow
                  ? `For work behind the scenes. Right now it uses ${backgroundNow.modelName} · ${backgroundNow.providerName}${roles.background?.default ? " (your cheapest)" : ""}.`
                  : "For work behind the scenes."
              }
              value={roles.background?.default ? "" : (roles.background?.provider ?? "")}
              providers={providers}
              automaticLabel="Cheapest saved model (automatic)"
              isDisabled={roleBusy}
              onChange={(provider) =>
                void saveRole(
                  { background: provider ? { provider } : null },
                  "Background model saved.",
                )
              }
            />
          </>
        )}
        <p className="text-sm text-text-muted">
          A single chat can use a different model: open the chat and pick one from the chip above
          the message box. Its history stays as it is.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <Heading level={3} className="text-lg font-semibold">
          Providers
        </Heading>
        {providers.length > 0 && (
          <ul className="flex flex-col gap-3">
            {providers.map((row) => (
              <ProviderCard
                key={row.id}
                row={row}
                isChat={roles.chat?.provider === row.id}
                badges={[
                  ...(roles.chat?.provider === row.id ? ["Chat model"] : []),
                  ...(roles.background?.provider === row.id ? ["Background model"] : []),
                ]}
                onChanged={changed}
              />
            ))}
          </ul>
        )}
        <div className={cardClass}>
          <Heading level={4} className="font-semibold">
            Add a provider
          </Heading>
          {addError && (
            <p role="alert" className="text-danger">
              {addError}
            </p>
          )}
          <ProviderForm value={addForm} onChange={setAddForm} />
          <div className="flex flex-wrap gap-2">
            <Button
              className={primary}
              isDisabled={addBusy}
              onPress={() => {
                if (!addForm.apiKey) {
                  setAddError("Enter the provider's API key.");
                  return;
                }
                void add(async () => {
                  await settingsApi("/providers", "POST", providerBody(addForm));
                }, "Provider added. Test it to check it answers.");
              }}
            >
              Add provider
            </Button>
            {!hasStarter && (
              <Button
                className={secondary}
                isDisabled={addBusy}
                onPress={() =>
                  void add(async () => {
                    await settingsApi("/providers", "POST", { kind: "workers-ai" });
                  }, "Workers AI starter added.")
                }
              >
                Add the Workers AI starter (no key)
              </Button>
            )}
          </div>
        </div>
      </div>

      <div role="status" className="sr-only">
        {announcement}
      </div>
    </section>
  );
}
