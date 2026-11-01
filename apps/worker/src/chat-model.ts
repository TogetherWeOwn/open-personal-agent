// SPDX-License-Identifier: Apache-2.0
// The model a user's saved settings name (ADR 0006), with its key decrypted from the vault. Chat
// turns and the settings Test button both resolve it per call, so a change applies to the next one.
import type { ModelProvider } from "@opa/core";
import { createRepository, type UserScope } from "@opa/db/repository";
import { billingProviderId } from "@opa/pricing";
import {
  createOpenAIChatProvider,
  createOpenAIResponsesProvider,
  createWorkersAIProvider,
  credentialBinding,
  usesOpenAIResponses,
  type WorkersAIBinding,
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

/**
 * Whether a base URL may use plain HTTP to any host: only with Node's guarded fetch, which refuses
 * plain HTTP to a public address. The flag alone never widens it.
 */
export const privateHttp = (env: Env) => env.MODEL_PRIVATE_HOSTS === true && !!env.MODEL_FETCH;

export async function resolveChatModel(
  env: Env,
  scope: UserScope,
  caller: string,
): Promise<ChatModel | { error: ChatModelError }> {
  const store = createRepository(env).forUser(scope).settings;
  const row = await store.get();
  if (!row?.modelKind || !row.model) return { error: "no_model" };
  if (row.modelKind === "workers-ai") {
    if (!env.AI) return { error: "ai_unavailable" };
    const provider = createWorkersAIProvider(env.AI as unknown as WorkersAIBinding);
    return { provider, model: row.model, apiKey: null };
  }
  if (!env.VAULT) return { error: "vault_unavailable" };
  const { providerId, baseUrl, keySecretId: secretId } = row;
  if (!providerId || !baseUrl || !secretId) return { error: "no_model" };
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
    // The OpenAI preset talks Responses with the same key and binding (M3-04 AC3).
    provider = usesOpenAIResponses(providerId, baseUrl)
      ? createOpenAIResponsesProvider(options)
      : createOpenAIChatProvider(options);
  } catch {
    // Saved as plain HTTP while private hosts were allowed, and they no longer are.
    return { error: "invalid_base_url" };
  }
  const billingId = billingProviderId(baseUrl);
  return { provider, model: row.model, apiKey, billingId, used: () => store.keyUsed(secretId) };
}
