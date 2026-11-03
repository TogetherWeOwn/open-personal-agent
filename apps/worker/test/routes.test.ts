// SPDX-License-Identifier: Apache-2.0
// R7 M2-1 (every non-public route needs a session) and M2-3 (the public list is exact).

import { createApp } from "@opa/server/app";
import { SESSION_COOKIE } from "@opa/server/auth";
import { PUBLIC_ROUTES, TOKEN_ROUTES } from "@opa/server/session";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { workerApp as app } from "../src/worker-app";
import { Browser, claim, db, env, freshDatabase, ORIGIN } from "./helpers/app";

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
        "POST /api/auth/recover/options",
        "POST /api/auth/recover",
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

  it("keeps every protected route closed before the claim", async () => {
    for (const route of protectedRoutes) {
      // Machine routes deny missing credentials before browser Origin/claim checks;
      // session routes retain the deployment's claim-first denial.
      const status = TOKEN_ROUTES.has(route) ? 401 : 403;
      expect([route, (await call(new Browser(), route)).status]).toEqual([route, status]);
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

  it("puts the routes createApp is given behind the same guards", async () => {
    const extra = new Hono<AppEnv>().get("/probe", (c) => c.text("ok"));
    const probe = () => createApp(extra).request(`${ORIGIN}/api/probe`, {}, env);
    expect((await probe()).status).toBe(403); // the claim guard
    await claim();
    expect((await probe()).status).toBe(401); // the session guard
  });

  it("holds every capability-token audience route, and each one is a real route", async () => {
    // Each audience route declares its exact partition. A token route must never overlap
    // the session surface.
    for (const [route, aud] of TOKEN_ROUTES) {
      expect(["model_proxy", "artifact_upload", "tool_gateway"]).toContain(aud);
      expect(routes).toContain(route);
      expect(PUBLIC_ROUTES.has(route)).toBe(false);
    }
    // A bearer for a token route must open only that route: `matchRoute` cannot tell which
    // route Hono would serve, so a token pattern matching any other route's path would let
    // the bearer open a session route (or shadow another token route).
    const methodOf = (route: string) => {
      const method = route.split(" ")[0];
      return method === "HEAD" ? "GET" : method;
    };
    const pathOf = (route: string) => route.split(" ").slice(1).join(" ");
    const overlaps = (pattern: string, other: string) => {
      if (methodOf(pattern) !== methodOf(other)) return false;
      const p = pathOf(pattern).split("/");
      const o = pathOf(other).split("/");
      return (
        p.length === o.length &&
        p.every((seg, i) => seg.startsWith(":") || o[i]?.startsWith(":") || seg === o[i])
      );
    };
    const violations: string[] = [];
    for (const [tokenRoute] of TOKEN_ROUTES)
      for (const other of routes)
        if (other !== tokenRoute && overlaps(tokenRoute, other))
          violations.push(`${tokenRoute} overlaps ${other}`);
    expect(violations).toEqual([]);
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
