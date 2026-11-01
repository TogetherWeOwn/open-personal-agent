// SPDX-License-Identifier: Apache-2.0
// Types for the mock OpenAI-compatible model server (scripts/mock-openai.mjs), which ships no
// types of its own. Kept next to the script so typechecked tests can import it.

export const MOCK_MODEL: string;

/** Starts the server on `port` (0 picks a free one). Resolves to `{ url, close }`. */
export function startMockOpenAI(options?: { port?: number; host?: string }): Promise<{
  url: string;
  close(): Promise<void>;
}>;
