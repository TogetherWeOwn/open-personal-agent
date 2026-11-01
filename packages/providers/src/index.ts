// SPDX-License-Identifier: Apache-2.0
export {
  DEFAULT_OPENAI_CHAT_COMPAT,
  OPENAI_CHAT_HOST_PRESETS,
  type OpenAIChatCompat,
} from "./compat";
export {
  canonicalOrigin,
  credentialBinding,
  legacyCredentialBinding,
} from "./credential-binding";
export {
  createOpenAIChatProvider,
  isLoopbackHost,
  type OpenAIChatOptions,
} from "./openai-chat";
export {
  createWorkersAIProvider,
  STARTER_MODEL,
  WORKERS_AI_PROVIDER_ID,
  type WorkersAIBinding,
} from "./workers-ai";
