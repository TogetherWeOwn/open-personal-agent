// SPDX-License-Identifier: Apache-2.0
// M3-21 AC9 (m3-spec §8 decision 1): in M3 the session cookie is the only way to authenticate.
// A request with `Authorization: Bearer` and no session gets 401 on every protected route, even
// when the bearer is a live session's own token, and the header changes nothing on a public one.
// Personal API tokens are M5's.
import { SESSION_COOKIE } from "@opa/server/auth";
import { PUBLIC_ROUTES } from "@opa/server/session";
import { describe, expect, it } from "vitest";
import { workerApp as app } from "../src/worker-app";
import { claim, db, env, freshDatabase, ORIGIN } from "./helpers/app";

freshDatabase();

/** Every route in the table, as `METHOD /path`. `ALL` entries are the global middleware. */
const routes = [
  ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
];

/** Requests `route` with each `:param` filled in, with `headers` and no cookie. */
function call(route: string, headers: Record<string, string> = {}) {
  const [method = "GET", path = "/"] = route.split(" ");
  const body = method === "GET" ? null : "{}";
  const init = { method, body, headers: { origin: ORIGIN, ...headers } };
  return app.request(`${ORIGIN}${path.replace(/:\w+/g, "x")}`, init, env);
}

/** The route code of both runtimes, as text. */
const sources = import.meta.glob(
  ["../../../packages/server/src/**/*.ts", "../src/**/*.ts", "../../node/src/**/*.ts"],
  { query: "?raw", import: "default", eager: true },
);

describe("a bearer token", () => {
  it("gets 401 on every protected route, even a live session's own token", async () => {
    const { browser } = await claim();
    const cookie = browser.cookies.get(SESSION_COOKIE) as string;
    const row = (await db.prepare("SELECT id FROM sessions").first<string>("id")) as string;
    const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(r));
    expect(protectedRoutes.length).toBeGreaterThan(10);
    for (const token of [cookie, row, "opa_pat_0123456789abcdef"]) {
      for (const route of protectedRoutes) {
        const res = await call(route, { authorization: `Bearer ${token}` });
        expect([route, res.status, await res.json()]).toEqual([
          route,
          401,
          { error: "unauthenticated" },
        ]);
      }
    }
    // The same session's cookie still works, so the 401s are the bearer's.
    expect((await browser.req("/api/me")).status).toBe(200);
  });

  it("changes nothing on a public route", async () => {
    const { browser } = await claim();
    const cookie = browser.cookies.get(SESSION_COOKIE) as string;
    for (const route of PUBLIC_ROUTES) {
      const plain = await call(route);
      const bearer = await call(route, { authorization: `Bearer ${cookie}` });
      expect([route, bearer.status]).toEqual([route, plain.status]);
    }
  });

  it("is read by no route: the app code never names the header", () => {
    const files = Object.keys(sources);
    expect(files.some((f) => f.endsWith("server/src/session.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("src/worker-app.ts"))).toBe(true);
    const readers = files.filter((f) => /authorization|bearer/i.test(sources[f] as string));
    expect(readers).toEqual([]);
  });
});
