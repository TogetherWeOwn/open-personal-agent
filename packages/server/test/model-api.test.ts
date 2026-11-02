// SPDX-License-Identifier: Apache-2.0
// The wire API a saved provider's calls use: an explicit choice saved with the endpoint wins,
// and without one the origin preset decides, as before.
import { describe, expect, it } from "vitest";
import { apiOf } from "../src/model-settings";

type Row = Parameters<typeof apiOf>[0];

const row = (over: Record<string, unknown>): Row =>
  ({
    id: "p1",
    kind: "openai-chat",
    providerId: "custom",
    baseUrl: "https://models.example.com/v1",
    model: "m",
    api: null,
    ...over,
  }) as Row;

describe("apiOf", () => {
  it("keeps the starter on the binding adapter", () => {
    expect(apiOf(row({ kind: "workers-ai", api: "openai-responses" }))).toBe("workers-ai");
  });

  it("prefers the saved choice over the origin preset", () => {
    expect(
      apiOf(
        row({ providerId: "openai", baseUrl: "https://api.openai.com/v1", api: "openai-chat" }),
      ),
    ).toBe("openai-chat");
    expect(
      apiOf(
        row({
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          api: "openai-responses",
        }),
      ),
    ).toBe("openai-responses");
    expect(apiOf(row({ api: "anthropic-messages" }))).toBe("anthropic-messages");
  });

  it("falls back to the origin preset without a saved choice", () => {
    expect(
      apiOf(row({ providerId: "openai", baseUrl: "https://api.openai.com/v1", api: null })),
    ).toBe("openai-responses");
    expect(
      apiOf(row({ providerId: "anthropic", baseUrl: "https://api.anthropic.com/v1", api: null })),
    ).toBe("anthropic-messages");
    expect(apiOf(row({ api: null }))).toBe("openai-chat");
  });
});
