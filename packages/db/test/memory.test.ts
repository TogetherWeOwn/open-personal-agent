// SPDX-License-Identifier: Apache-2.0
// The trust gate's pure parts. The gate itself runs against D1 and SQLite in the memory contract
// (test/contract/storage.ts).
import { describe, expect, it } from "vitest";
import { ftsQuery, redactSecrets, trustOf } from "../src/memory";

describe("trustOf", () => {
  it("takes trust from who is writing, and a tainted context from nobody", () => {
    expect([
      trustOf({ via: "system" }),
      trustOf({ via: "user" }),
      trustOf({ via: "assistant", tainted: false, userAsserted: true }),
      trustOf({ via: "assistant", tainted: false, userAsserted: false }),
      trustOf({ via: "assistant", tainted: true, userAsserted: true }),
    ]).toEqual(["system", "user", "user", "inferred", "external"]);
  });
});

describe("redactSecrets", () => {
  it("redacts credentials, private keys and card numbers", () => {
    const pem = ["-----BEGIN", "PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----"].join(" ");
    for (const secret of [
      "sk-proj-abcdefghijklmnop1234567890",
      "sk-ant-api03-abcdefghijklmnopqrstu",
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"B".repeat(40)}`,
      "AKIAABCDEFGHIJKLMNOP",
      `AIza${"x".repeat(35)}`,
      "xoxb-1234567890-abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
      pem,
      "4111 1111 1111 1111",
    ]) {
      expect(redactSecrets(`before ${secret} after`), secret).toBe("before [redacted] after");
    }
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("[redacted]");
    expect(redactSecrets("my password is hunter2!")).toBe("my password is [redacted]");
    expect(redactSecrets("API key: abc123")).toBe("API key: [redacted]");
  });

  it("leaves ordinary text and numbers alone", () => {
    for (const text of [
      "I'm vegetarian",
      "Call me on 0113 496 0000",
      "Order 1234 5678 9012 3456 arrives Tuesday", // fails the Luhn check
      "skiing in the Alps",
      "the secret is time",
      "the token is valid",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe("ftsQuery", () => {
  it("quotes each word, so FTS5 syntax in the input is never an operator", () => {
    expect(ftsQuery("Sam's café")).toBe('"Sam"* "s"* "café"*');
    expect(ftsQuery('") OR NEAR(x *')).toBe('"OR"* "NEAR"* "x"*');
    expect(ftsQuery(" - ")).toBeNull();
    expect(ftsQuery("a ".repeat(40))?.split(" ")).toHaveLength(16);
  });
});
