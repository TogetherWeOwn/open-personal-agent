// SPDX-License-Identifier: Apache-2.0
// The model a user's saved settings name (ADR 0006), with its key decrypted from the vault. Chat
// turns and the settings Test button both resolve it per call, so a change applies to the next one.
import type { ModelProvider } from "@opa/core";
import { createRepository, type UserScope } from "@opa/db/repository";
import { billingProviderId, estimate, findPrice } from "@opa/pricing";
import {
  createOpenAIChatProvider,
  createWorkersAIProvider,
  credentialBinding,
  WORKERS_AI_PROVIDER_ID,
} from "@opa/providers";
import { decrypt, type UserScope as VaultScope } from "@opa/vault";
import type { Env } from "./env";

export const MODEL_KEY_PURPOSE = "model_api_key" as const;

export interface ChatModel {
  provider: ModelProvider;
  model: string;
  apiKey: string | null;
  /** Who bills the calls, for the usage ledger; the provider's own ID when it is the biller. */
  billingId?: string;
  /** Records the saved key's use; callers run it just before the model call. */
  used?: () => Promise<void>;
}

export type ChatModelError =
  | "no_model"
  | "ai_unavailable"
  | "vault_unavailable"
  | "key_required"
  | "invalid_base_url";

/** Which model to resolve: a role (COST-7), a conversation's own pick, or one saved provider. */
export type ModelPick =
  | { role: "chat" | "background" }
  | { conversationId: string }
  | { provider: string; model?: string };

type Providers = ReturnType<ReturnType<typeof createRepository>["forUser"]>["providers"];
type ProviderRow = NonNullable<Awaited<ReturnType<Providers["get"]>>>;

/**
 * Whether a base URL may use plain HTTP to any host: only with Node's guarded fetch, which refuses
 * plain HTTP to a public address. The flag alone never widens it.
 */
export const privateHttp = (env: Env) => env.MODEL_PRIVATE_HOSTS === true && !!env.MODEL_FETCH;

/** Who bills a saved provider's calls; the price table and the ledger both key on it. */
export const billerOf = (row: Pick<ProviderRow, "kind" | "baseUrl">) =>
  row.kind === "workers-ai" || !row.baseUrl
    ? WORKERS_AI_PROVIDER_ID
    : billingProviderId(row.baseUrl);

/** The size of message "cheapest" is measured on: a short question with a little context. */
const REFERENCE_CALL = { inputTokens: 1000, outputTokens: 300, cachedInputTokens: 0 };

/** A model's estimated cost for the reference call; unpriced models sort last. */
function referenceCost(row: ProviderRow, model: string) {
  const price = findPrice(billerOf(row), model);
  return price ? estimate(price, REFERENCE_CALL).costMicroUsd : Number.POSITIVE_INFINITY;
}

/**
 * The provider and model a pick names, with every read scoped to the user. Background defaults
 * to the cheapest saved model, and a tie keeps the Chat role's.
 */
export async function pickModel(env: Env, scope: UserScope, pick: ModelPick) {
  const user = createRepository(env).forUser(scope);
  const { providers } = user;
  const named = async (id: string | null | undefined, model: string | null | undefined) => {
    const row = id ? await providers.get(id) : undefined;
    const chosen = model ?? row?.model;
    return row && chosen ? { row, model: chosen } : null;
  };
  if ("provider" in pick) return named(pick.provider, pick.model);
  const settings = await user.settings.get();
  const chat = () => named(settings?.chatProvider, settings?.chatModel);
  if ("conversationId" in pick) {
    const conversation = await user.getConversation(pick.conversationId);
    return (await named(conversation?.modelProvider, conversation?.model)) ?? chat();
  }
  if (pick.role === "chat") return chat();
  const set = await named(settings?.backgroundProvider, settings?.backgroundModel);
  if (set) return set;
  let best = await chat();
  for (const row of await providers.list()) {
    if (!row.model) continue;
    if (!best || referenceCost(row, row.model) < referenceCost(best.row, best.model)) {
      best = { row, model: row.model };
    }
  }
  return best;
}

export async function resolveChatModel(
  env: Env,
  scope: UserScope,
  caller: string,
  pick: ModelPick = { role: "chat" },
): Promise<ChatModel | { error: ChatModelError }> {
  const picked = await pickModel(env, scope, pick);
  if (!picked) return { error: "no_model" };
  const { row, model } = picked;
  if (row.kind === "workers-ai") {
    if (!env.AI) return { error: "ai_unavailable" };
    const provider = createWorkersAIProvider(env.AI);
    return { provider, model, apiKey: null };
  }
  if (!env.VAULT) return { error: "vault_unavailable" };
  const { providerId, baseUrl, keySecretId: secretId } = row;
  if (!providerId || !baseUrl || !secretId) return { error: "key_required" };
  const binding = credentialBinding(providerId, baseUrl);
  const ref = { secretId, purpose: MODEL_KEY_PURPOSE, binding, caller } as const;
  // The vault takes the repository's scope too; its own brand keeps it from importing `@opa/db`.
  // A lost master key makes saved keys unreadable; the user enters theirs again.
  const apiKey = await decrypt(env.VAULT, scope as unknown as VaultScope, ref).catch(() => null);
  if (apiKey === null) return { error: "key_required" };
  // The base URL is the user's, so on Node this goes through the SSRF-guarded fetch (ADR 0010 D8).
  const fetch = env.MODEL_FETCH ? { fetch: env.MODEL_FETCH } : {};
  let provider: ModelProvider;
  try {
    const options = { providerId, baseUrl, apiKey, privateHttp: privateHttp(env), ...fetch };
    provider = createOpenAIChatProvider(options);
  } catch {
    // Saved as plain HTTP while private hosts were allowed, and they no longer are.
    return { error: "invalid_base_url" };
  }
  const store = createRepository(env).forUser(scope).settings;
  const used = () => store.keyUsed(secretId);
  return { provider, model, apiKey, billingId: billerOf(row), used };
}
