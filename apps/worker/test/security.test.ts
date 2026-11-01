// SPDX-License-Identifier: Apache-2.0
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import wrangler from "../../../wrangler.jsonc?raw";
import staticHeaders from "../../web/public/_headers?raw";
import { API_CSP, APP_CSP, COMMON_HEADERS, userContent } from "../src/security";

const ORIGIN = "https://opa.example.workers.dev";
const SIBLING = "https://evil.example.workers.dev"; // same site, different origin
const fetchApp = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`${ORIGIN}${path}`, init));

describe("security headers", () => {
  it("sets the common headers and keeps a route's own CSP", async () => {
    for (const [path, csp] of [
      ["/api/health", API_CSP],
      ["/api/nope", API_CSP],
      ["/setup", "default-src 'none'; style-src 'unsafe-inline'"],
    ]) {
      const res = await fetchApp(path ?? "");
      expect(Object.fromEntries(res.headers)).toMatchObject({
        ...Object.fromEntries(Object.entries(COMMON_HEADERS).map(([k, v]) => [k.toLowerCase(), v])),
        "content-security-policy": csp,
      });
    }
  });

  it("gives static assets the same headers through _headers, and logs no invocations", () => {
    const lines = staticHeaders.split("\n").filter((l) => /^\s+\S+: /.test(l));
    const parsed = Object.fromEntries(
      lines.map((l) =>
        l
          .trim()
          .split(/: (.*)/s)
          .slice(0, 2),
      ),
    );
    expect(parsed).toEqual({ "Content-Security-Policy": APP_CSP, ...COMMON_HEADERS });
    expect(wrangler).toMatch(/"logs":\s*\{[^}]*"invocation_logs":\s*false/);
  });
});

describe("origin and CORS", () => {
  it("rejects a state change from a same-site sibling, or with no exact Origin", async () => {
    const bad = [
      { Origin: SIBLING },
      { Origin: "null" },
      {},
      { Origin: ORIGIN, "Sec-Fetch-Site": "same-site" },
    ];
    for (const [path, headers] of [
      ...bad.map((h) => ["/api/health", h] as const),
      ["/hooks/anything", { Origin: SIBLING }] as const, // no path is exempt
    ]) {
      const res = await fetchApp(path, { method: "POST", headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "bad_origin" });
    }
    const ok = await fetchApp("/api/nope", { method: "POST", headers: { Origin: ORIGIN } });
    // Past the check, into the claim guard (M2-09).
    expect(await ok.json()).toEqual({ error: "not_claimed" });
  });

  it("answers no preflight or cross-origin read with CORS headers", async () => {
    const preflight = {
      method: "OPTIONS",
      headers: { Origin: SIBLING, "Access-Control-Request-Method": "POST" },
    };
    for (const init of [preflight, { headers: { Origin: SIBLING } }]) {
      const res = await fetchApp("/api/health", init);
      expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("user content", () => {
  it("previews under CSP sandbox and downloads the rest as opaque attachments", () => {
    for (const [type, disposition] of [
      ["text/html", "inline"],
      ["image/svg+xml", "inline"],
      ["application/javascript", "attachment"],
    ]) {
      const res = userContent("x", type ?? "", 'r"e\nport.html');
      expect(res.headers.get("Content-Security-Policy")).toMatch(/^sandbox;/);
      expect(res.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
      expect(res.headers.get("Content-Disposition")).toBe(
        `${disposition}; filename="r_e_port.html"; filename*=UTF-8''r%22e%0Aport.html`,
      );
    }
    expect(userContent("x", "application/javascript", "a.js").headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });
});
