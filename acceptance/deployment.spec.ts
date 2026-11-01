// SPDX-License-Identifier: Apache-2.0
// Black-box checks of a deployment at BASE_URL (a local stack without one), claimed or not. They
// need no secrets and change nothing, so they can run against a live URL.
// PRD §11: #11 Portability (it runs locally) and #2 Easy deployment (a fresh deploy answers).
import { expect, test } from "@playwright/test";

test("health reports a migrated database", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = await res.json();
  // After the claim, a caller without a session gets only the status (M2-22).
  if (Object.keys(body).length === 1) return expect(body).toEqual({ status: "ok" });
  expect(body).toMatchObject({
    schema: { current: true },
    checks: { database: true, durableObject: true },
  });
});

test("the app loads only from its own origin and asks who you are", async ({ page, baseURL }) => {
  const origins = new Set<string>();
  page.on("request", (req) => origins.add(new URL(req.url()).origin));
  await page.goto("/");
  // Unclaimed: the claim page. Claimed: sign in. Never the chat without a session.
  await expect(
    page.getByRole("heading", { name: /^(Claim your assistant|Sign in|Finish setup)/ }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  expect([...origins]).toEqual([new URL(baseURL ?? "").origin]);
});

test("the API needs a session and sends the security headers", async ({ request }) => {
  const res = await request.get("/api/me");
  expect([401, 403]).toContain(res.status());
  const headers = res.headers();
  expect(headers["content-security-policy"]).toContain("default-src 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(Object.keys(headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
});

test("the chat socket refuses another site and a missing session", async ({ request }) => {
  const upgrade = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": btoa("sixteen byte key"), // any 16 bytes, base64
  };
  for (const origin of ["https://attacker.example", undefined]) {
    const headers = origin ? { ...upgrade, Origin: origin } : upgrade;
    const res = await request.get("/api/chat", { headers });
    expect([401, 403]).toContain(res.status());
  }
});
