// SPDX-License-Identifier: Apache-2.0
// The model a user's saved settings name (ADR 0006), with its key decrypted from the vault. Chat
// turns and the settings Test button both resolve it per call, so a change applies to the next one.
import type { ModelProvider } from "@opa/core";
import { createRepository, type UserScope } from "@opa/db/repository";
import {
  createOpenAIChatProvider,
  createWorkersAIProvider,
  credentialBinding,
  type WorkersAIBinding,
} from "@opa/providers";
import { decrypt, type UserScope as VaultScope } from "@opa/vault";
import type { Env } from "./env";

export const MODEL_KEY_PURPOSE = "model_api_key" as const;

export interface ChatModel {
  provider: ModelProvider;
  model: string;
  apiKey: string | null;
  /** Records the saved key's use; callers run it just before the model call. */
  used?: () => Promise<void>;
}

export type ChatModelError = "no_model" | "ai_unavailable" | "vault_unavailable" | "key_required";

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
  const provider = createOpenAIChatProvider({ providerId, baseUrl, apiKey, ...fetch });
  return { provider, model: row.model, apiKey, used: () => store.keyUsed(secretId) };
}
