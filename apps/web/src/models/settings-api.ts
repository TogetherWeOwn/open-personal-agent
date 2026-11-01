// SPDX-License-Identifier: Apache-2.0
// The model settings the server sends (M3-06): saved providers with their keys' last 4 and
// dates, the Chat and Background roles, and Test results. A saved key never comes back from
// the server, so nothing here can hold one beyond the form field it was typed into.
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";

export interface PriceHint {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** The day the price was last checked against its source, YYYY-MM-DD. */
  verifiedAt: string;
  stale: boolean;
}

/** One row of `providers` in the settings view. */
export interface SavedProvider {
  id: string;
  kind: "openai-chat" | "workers-ai";
  api: "openai-chat" | "openai-responses" | "anthropic-messages" | "workers-ai";
  providerId: string | null;
  baseUrl: string | null;
  providerName: string;
  model: string | null;
  modelName: string | null;
  createdAt: number;
  key: {
    last4: string | null;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number | null;
  } | null;
  price: PriceHint | null;
}

export interface RolePick {
  provider: string;
  model: string;
}

/** `GET /api/settings` as onboarding, the Models page and the context chip read it. */
export interface ModelSettings {
  displayName: string;
  about: string;
  onboarded: boolean;
  /** The Chat role's model in the shape onboarding has always read; null before one is saved. */
  model: {
    kind: "openai-chat" | "workers-ai";
    providerId: string | null;
    baseUrl: string | null;
    model: string;
    key: SavedProvider["key"];
  } | null;
  providers: SavedProvider[];
  roles: {
    chat: RolePick | null;
    /** `default` says nobody chose it: it is the cheapest saved model, picked for you. */
    background: (RolePick & { default: boolean }) | null;
    embedding: null;
  };
}

export type TestResult =
  | {
      ok: true;
      latencyMs: number;
      tools: boolean;
      /** How the tool-call probe went; absent from older test doubles. */
      toolProbe?: "called" | "ignored" | "rejected" | "timeout" | "failed";
      price?: PriceHint | null;
      reply: string;
    }
  | { ok: false; error: { message: string } };

export async function settingsApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/settings${path}`, init);
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Pins a conversation to a model, or back to the Chat role with `null` (M3-06 AC3). */
export async function setConversationModel(
  conversationId: string,
  pick: RolePick | null,
): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}/model`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pick),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
}

const ERRORS: Record<string, string> = {
  key_required: "Enter the API key again: it belongs to a different provider or address.",
  invalid_base_url:
    "The base URL must be a valid https:// address (http:// only for a local or LAN model server this deployment allows).",
  invalid_model: "Check the provider, model and key, then try again.",
  invalid_role: "That model isn't one of your saved providers any more.",
  chat_role:
    "This provider is your chat model. Choose a different chat model first, then remove it.",
  vault_unavailable: "Keys can't be saved until the server's master key is fixed.",
  vault_reset_required:
    "Your saved keys can't be opened with this server's master key. Reset them, then enter your key again.",
  ai_unavailable: "Workers AI isn't connected to this deployment. Use an API key instead.",
  not_found: "That was already removed. The list has been refreshed.",
};
export const settingsError = (e: unknown) =>
  ERRORS[(e as Error).message] ?? "That didn't work. Check the fields and try again.";

/** The server refused because the user's saved keys no longer open: the reset panel takes over. */
export const needsVaultReset = (e: unknown) => (e as Error).message === "vault_reset_required";

/** `GET /api/settings/vault`: whether the user's saved keys open (crypto review C-1). */
export type VaultState = "ok" | "empty" | "reset_required" | "unavailable";

/** The vault's state, or null when the server can't say (no vault configured, or offline). */
export const vaultState = () =>
  settingsApi<{ state: VaultState }>("/vault").then(
    ({ state }) => state,
    () => null,
  );

/**
 * Deletes the user's saved keys after a passkey step-up for `vault.reset`. Rejects with the
 * server's error code, or the browser's error when the passkey prompt is dismissed.
 */
export async function resetVault(retried = false): Promise<void> {
  const res = await fetch("/api/auth/step-up/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "vault.reset" }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    options?: PublicKeyCredentialRequestOptionsJSON;
    error?: string;
  };
  if (!res.ok || !json.options) throw new Error(json.error ?? "unknown");
  const credential = await startAuthentication({ optionsJSON: json.options });
  try {
    await settingsApi("/vault/reset", "POST", { confirm: "reset", credential });
  } catch (e) {
    // The challenge expired or its cookie was lost: one fresh ceremony, without asking.
    if ((e as Error).message === "step_up_required" && !retried) return resetVault(true);
    throw e;
  }
}

// The size of message prices are explained with: a short question with a little context, the
// server's reference call (packages/server/src/chat-model.ts), so "cheapest" and the price
// hint measure the same message.
const REFERENCE = { inputTokens: 1000, outputTokens: 300 };

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });

/** "about $0.40 per 100 messages" (COST-7), or null when the model has no price on file. */
export function per100Messages(price: PriceHint | null | undefined): string | null {
  if (!price) return null;
  const perMessage =
    (REFERENCE.inputTokens * price.inputUsdPerMTok +
      REFERENCE.outputTokens * price.outputUsdPerMTok) /
    1e6;
  return `about ${usd.format(perMessage * 100)} per 100 messages`;
}

/** A price's check date in words: "price checked 1 Nov 2026". */
export function priceChecked(price: PriceHint): string {
  const day = new Date(`${price.verifiedAt}T00:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  return price.stale ? `price last checked ${day}; it may have changed` : `price checked ${day}`;
}

/** A stored timestamp as a plain date: "1 Nov 2026". */
export const dayOf = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { dateStyle: "medium" });

/** The model a role or pin names, as read on the chip: "GPT-4.1 mini · OpenAI". */
export function describePick(settings: ModelSettings, pick: RolePick) {
  const row = settings.providers.find((p) => p.id === pick.provider);
  const modelName = row && row.model === pick.model ? (row.modelName ?? pick.model) : pick.model;
  return { modelName, providerName: row?.providerName ?? "a removed provider", row };
}
