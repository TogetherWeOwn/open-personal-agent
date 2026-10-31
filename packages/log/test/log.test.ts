// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/index";

function capture(fields: Record<string, unknown>): unknown {
  const lines: string[] = [];
  createLogger((line) => lines.push(line)).info("test.event", fields);
  return JSON.parse(lines[0] ?? "{}");
}

describe("allowlist logger", () => {
  it("writes allowlisted scalar fields and drops everything else", () => {
    const fields = { route: "/x", status: 200, url: "/x?token=1", reason: new Error("secret") };
    expect(capture(fields)).toEqual({
      level: "info",
      event: "test.event",
      route: "/x",
      status: 200,
      dropped: 2,
    });
  });

  it("redacts secret-shaped strings", () => {
    for (const secret of [
      "Bearer abc",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      "sk-proj-abcdefghijkl",
      "opa-canary-0123456789abcdef0123456789abcdef",
      "b3BhLWNhbmFyeS0wMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZg==", // the same, base64
    ]) {
      expect(redact(`x ${secret} y`)).toBe("x [redacted] y");
    }
    expect(redact("ab ".repeat(100))).toHaveLength(201);
  });
});
