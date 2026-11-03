// SPDX-License-Identifier: Apache-2.0
// Types for the mock OpenAI-compatible model server (scripts/mock-openai.mjs), which ships no
// types of its own. Kept next to the script so typechecked tests can import it.

export const MOCK_MODEL: string;

/** One scripted answer per chat-completions call: a tool call, or the text ending the turn. */
export type MockScriptEntry = { tool: string; args?: unknown } | { text: string };

/**
 * Starts the server on `port` (0 picks a free one). Resolves to `{ url, close, requests }`:
 * `requests` holds one entry per call with the offered tool names in order. With `script`,
 * each call answers with the next entry (a spent script echoes); without it, the first
 * offered tool is called once, then the echo.
 */
export function startMockOpenAI(options?: {
  port?: number;
  host?: string;
  script?: MockScriptEntry[];
}): Promise<{
  url: string;
  close(): Promise<void>;
  requests: { tools: string[] }[];
}>;
