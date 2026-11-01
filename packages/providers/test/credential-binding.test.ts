// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  canonicalOrigin,
  credentialBinding,
  legacyCredentialBinding,
} from "../src/credential-binding";

// Stands in for the vault (M2-07): AES-256-GCM with the ADR 0010 D4 secret AAD
// `user_id|secret_id|purpose|binding|version`.
const gcm = (iv: Uint8Array<ArrayBuffer>, binding: string) => ({
  name: "AES-GCM",
  iv,
  additionalData: new TextEncoder().encode(`u1|s1|model_api_key|${binding}|1`),
});

describe("credential binding", () => {
  it("canonicalizes the origin and the path, without trailing slashes", () => {
    expect(canonicalOrigin("HTTPS://API.OpenAI.com:443/v1/")).toBe("https://api.openai.com");
    expect(canonicalOrigin("http://localhost:11434/v1")).toBe("http://localhost:11434");
    for (const url of [
      "https://api.openai.com/v1",
      "HTTPS://API.OpenAI.com:443/v1//",
      "https://api.openai.com/x/../v1",
    ]) {
      expect(credentialBinding("openai", url)).toBe("model:openai|https://api.openai.com/v1");
    }
    expect(credentialBinding("openai", "https://api.openai.com/")).toBe(
      "model:openai|https://api.openai.com",
    );
    expect(legacyCredentialBinding("openai", "https://api.openai.com/v1")).toBe(
      "model:openai|https://api.openai.com",
    );
  });

  it("rejects unusable base URLs and provider ids", () => {
    expect(() => canonicalOrigin("not a url")).toThrow("valid URL");
    expect(() => canonicalOrigin("ftp://example.test")).toThrow("https or http");
    expect(() => canonicalOrigin("https://user:pw@example.test")).toThrow("credentials");
    expect(() => credentialBinding("a|b", "https://example.test")).toThrow("provider id");
  });

  it("a key bound to one endpoint fails decryption under another", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bound = credentialBinding("openai", "https://api.openai.com/v1");
    const sealed = await crypto.subtle.encrypt(
      gcm(iv, bound),
      key,
      new TextEncoder().encode("sk-canary"),
    );
    const open = (providerId: string, baseUrl: string) =>
      crypto.subtle.decrypt(gcm(iv, credentialBinding(providerId, baseUrl)), key, sealed);

    expect(new TextDecoder().decode(await open("openai", "https://api.openai.com/v1/"))).toBe(
      "sk-canary",
    );
    for (const [providerId, baseUrl] of [
      // Same origin, another path: another AI Gateway account, say (crypto review I-2).
      ["openai", "https://api.openai.com/v2"],
      ["openai", "https://api.openai.com/v1/other"],
      ["openai", "https://api.openai.com.attacker.test/v1"],
      ["openai", "http://api.openai.com/v1"],
      ["openai", "https://api.openai.com:8443/v1"],
      ["openai", "https://eu.api.openai.com/v1"],
      ["openrouter", "https://api.openai.com/v1"],
    ] as const) {
      await expect(open(providerId, baseUrl)).rejects.toThrow();
    }
  });
});
