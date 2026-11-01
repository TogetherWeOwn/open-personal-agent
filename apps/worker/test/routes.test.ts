// SPDX-License-Identifier: Apache-2.0
// R7 M2-1 (every non-public route needs a session) and M2-3 (the public list is exact).
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import { SESSION_COOKIE } from "../src/auth";
import { PUBLIC_ROUTES } from "../src/session";
import { Browser, claim, db, freshDatabase } from "./helpers/app";

freshDatabase();

/** Every route in the table, as `METHOD /path`. `ALL` entries are the global middleware. */
const routes = [
  ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
];
const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(r));

/** Requests `METHOD /path` with each `:param` filled in, as `browser`. */
function call(browser: Browser, route: string) {
  const [method = "GET", path = "/"] = route.split(" ");
  return browser.req(path.replace(/:\w+/g, "x"), {
    method,
    body: method === "GET" ? undefined : {},
  });
}

describe("the route table", () => {
  it("has exactly this public list, and every entry is a real route", () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual(
      [
        "GET /api/health",
        "GET /setup",
        "POST /setup",
        "POST /setup/options",
        "POST /api/auth/login/options",
        "POST /api/auth/login",
      ].sort(),
    );
    for (const route of PUBLIC_ROUTES) expect(routes).toContain(route);
  });

  it("has protected routes to check", () => {
    expect(protectedRoutes).toEqual(
      expect.arrayContaining([
        "GET /api/me",
        "GET /api/sessions",
        "DELETE /api/sessions/:id",
        "POST /api/sessions/revoke-all",
        "POST /api/auth/logout",
      ]),
    );
  });

  it("answers 403 on every protected route before the claim", async () => {
    for (const route of protectedRoutes) {
      expect([route, (await call(new Browser(), route)).status]).toEqual([route, 403]);
    }
  });

  it("answers 401 on every protected route without a live session", async () => {
    const { browser } = await claim();
    const cookie = browser.cookies.get(SESSION_COOKIE) as string;
    await db.prepare("UPDATE sessions SET revoked_at = 1").run();
    const revoked = new Browser();
    revoked.cookies.set(SESSION_COOKIE, cookie);
    const forged = new Browser();
    forged.cookies.set(SESSION_COOKIE, "not-a-session");
    for (const br of [new Browser(), revoked, forged]) {
      for (const route of protectedRoutes) {
        const res = await call(br, route);
        expect([route, res.status]).toEqual([route, 401]);
        expect(await res.json()).toEqual({ error: "unauthenticated" });
      }
    }
    // An unknown path is closed too: the guard runs before the 404.
    expect((await new Browser().req("/api/unknown")).status).toBe(401);
  });

  it("answers no public route with 401", async () => {
    await claim();
    for (const route of PUBLIC_ROUTES) {
      expect([route, (await call(new Browser(), route)).status]).not.toEqual([route, 401]);
    }
    // Hono answers HEAD with the GET handler, so HEAD on a public GET is public too.
    expect((await new Browser().req("/api/health", { method: "HEAD" })).status).not.toBe(401);
    expect((await new Browser().req("/api/me", { method: "HEAD" })).status).toBe(401);
  });
});
