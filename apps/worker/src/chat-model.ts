// SPDX-License-Identifier: Apache-2.0
// The model a chat turn calls (ADR 0006), resolved per turn, so a settings change applies to the
// next turn. Saved model settings and their vaulted keys join with M2-15a.
import type { ModelProvider } from "@opa/core";
import type { UserScope } from "@opa/db/repository";
import { createWorkersAIProvider, STARTER_MODEL } from "@opa/providers";
import type { Env } from "./env";

export type ChatModel = { provider: ModelProvider; model: string };

export async function resolveChatModel(env: Env, _scope: UserScope): Promise<ChatModel> {
  return { provider: createWorkersAIProvider(env.AI), model: STARTER_MODEL };
}
