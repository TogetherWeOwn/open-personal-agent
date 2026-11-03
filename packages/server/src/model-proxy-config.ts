// SPDX-License-Identifier: Apache-2.0
import type { CapabilityScope } from "@opa/db/capability-tokens";
import { createRepository, type UserScope } from "@opa/db/repository";
import { credentialBinding, usesAnthropicMessages, usesOpenAIResponses } from "@opa/providers";
import { decrypt, type UserScope as VaultScope } from "@opa/vault";
import { billerOf, MODEL_KEY_PURPOSE, pickModel } from "./chat-model";
import type { Env } from "./env";
import type { ProxyProvider } from "./model-proxy";

/** A minted ceiling never authorizes a pair that the task's live model selection no longer names. */
export async function resolveProxyProvider(
  env: Env,
  scope: UserScope,
  capability: CapabilityScope,
  providerId: string,
  model: string,
): Promise<(ProxyProvider & { billingId: string }) | null> {
  if (scope.userId !== capability.userId || !env.VAULT) return null;
  const user = createRepository(env).forUser(scope);
  const task = await user.tasks.get(capability.taskId);
  if (!task) return null;
  const picked = await pickModel(
    env,
    scope,
    task.kind === "turn" ? { conversationId: task.conversationId } : { role: "background" },
  );
  if (!picked || picked.row.id !== providerId || picked.model !== model) return null;
  const { row } = picked;
  if (row.kind === "workers-ai" || !row.baseUrl || !row.providerId || !row.keySecretId) return null;
  const apiKey = await decrypt(env.VAULT, scope as unknown as VaultScope, {
    secretId: row.keySecretId,
    purpose: MODEL_KEY_PURPOSE,
    binding: credentialBinding(row.providerId, row.baseUrl),
    caller: "model_proxy",
  }).catch(() => null);
  if (!apiKey) return null;
  const api =
    row.api ??
    (usesOpenAIResponses(row.providerId, row.baseUrl)
      ? "openai-responses"
      : usesAnthropicMessages(row.providerId, row.baseUrl)
        ? "anthropic-messages"
        : "openai-chat");
  await user.settings.keyUsed(row.keySecretId);
  return { baseUrl: row.baseUrl, api, apiKey, billingId: billerOf(row) };
}
