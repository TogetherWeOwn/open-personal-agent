// SPDX-License-Identifier: Apache-2.0
// The model a chat turn calls (ADR 0006), resolved per turn so a settings change applies to the
// next one. The user's saved settings and vaulted key join with M2-15a.
import type { UserScope } from "@opa/db/repository";
import { createWorkersAIProvider, STARTER_MODEL } from "@opa/providers";
import type { Env } from "./env";

export async function resolveChatModel(env: Env, _scope: UserScope) {
  return { provider: createWorkersAIProvider(env.AI), model: STARTER_MODEL };
}
