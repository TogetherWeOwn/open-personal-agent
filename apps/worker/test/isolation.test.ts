// SPDX-License-Identifier: Apache-2.0
// M3-21 🔒 data isolation (21a): AC1 (B gets 404 for A's IDs on every ID route, lists never carry
// A's items, and a write to A's ID changes nothing), AC5 (the same with A, the owner, against a
// second user) and AC7 (a new ID route without a case here fails the build). R7 M3-1–M3-5.
//
// A card that adds a route with an `:id` adds its case to `CASES`. The chat socket carries its
// conversation ID in frames: chat.test.ts "refuses another user's conversation…" covers it.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { PUBLIC_ROUTES } from "@opa/server/session";
import { builtinTools } from "@opa/server/tools";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workerApp as app } from "../src/worker-app";
import { db } from "./helpers/app";
import { as, BASE_URL, leaked, type Seeded, seedBoth, snapshot } from "./helpers/isolation";

/** A tool to set an override on; the real ones arrive with M3-08. */
const TOOL = "isolation_probe";

interface Case {
  /** The route's params, filled from the victim's items. */
  params: (victim: Seeded) => Record<string, string>;
  /** A body the route would accept from the item's owner, so a 404 isn't a 400 in disguise. */
  body?: (victim: Seeded, attacker: Seeded) => unknown;
  /** The attacker's status: 404 unless the param names something no user owns. */
  status?: number;
  /** The owner's own status: proof the route found the item, so the attacker's 404 means "not yours". */
  own: number;
}

/** One case per protected route that takes a param, as `METHOD /path`. */
const CASES: Record<string, Case> = {
  "GET /api/conversations/:id/messages": { params: (v) => ({ id: v.conversation }), own: 200 },
  "PUT /api/conversations/:id/model": {
    params: (v) => ({ id: v.conversation }),
    body: (_v, a) => ({ provider: a.provider, model: "gpt-4o" }),
    own: 200,
  },
  "GET /api/artifacts/:id": { params: (v) => ({ id: v.artifact }), own: 200 },
  "GET /api/artifacts/:id/content": { params: (v) => ({ id: v.artifact }), own: 200 },
  "DELETE /api/artifacts/:id": { params: (v) => ({ id: v.artifact }), own: 204 },
  "GET /api/attachments/:id": { params: (v) => ({ id: v.attachment }), own: 200 },
  "DELETE /api/attachments/:id": { params: (v) => ({ id: v.attachment }), own: 204 },
  "GET /api/exports/:id": { params: (v) => ({ id: v.export }), own: 200 },
  // The spare session: revoking the one the owner signs in with would 401 every later route.
  "DELETE /api/sessions/:id": { params: (v) => ({ id: v.spareSession }), own: 200 },
  "PUT /api/settings/providers/:id": {
    params: (v) => ({ id: v.provider }),
    body: () => ({ providerId: "openai", baseUrl: BASE_URL, model: "gpt-4o-mini" }),
    own: 200,
  },
  // The owner's provider is their Chat role, so it's refused as in use, after it was found.
  "DELETE /api/settings/providers/:id": { params: (v) => ({ id: v.provider }), own: 409 },
  "POST /api/settings/providers/:id/test": {
    params: (v) => ({ id: v.provider }),
    body: () => ({}),
    own: 200,
  },
  "DELETE /api/settings/grants/:id": { params: (v) => ({ id: v.grant }), own: 204 },
  // The task is resumed, then put back: no Workflow instance runs in the test to wake ("ended").
  "POST /api/tasks/:id/continue": { params: (v) => ({ id: v.task }), body: () => ({}), own: 409 },
  "POST /api/tasks/:id/stop": { params: (v) => ({ id: v.task }), body: () => ({}), own: 200 },
  // A tool name, not an item: the attacker sets their own override, and the victim's stays.
  "PUT /api/settings/tools/:name": {
    params: () => ({ name: TOOL }),
    body: () => ({ override: "never" }),
    status: 200,
    own: 200,
  },
};

/** Every route in the table, as `METHOD /path`, without the global middleware. */
const routes = [
  ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
];
const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(r));
const idRoutes = protectedRoutes.filter((r) => r.includes("/:"));
/** The lists: every protected GET without a param, but the chat socket. */
const lists = protectedRoutes.filter(
  (r) => r.startsWith("GET ") && !r.includes("/:") && r !== "GET /api/chat",
);

const fill = (route: string, params: Record<string, string>) => {
  const [method = "", path = ""] = route.split(" ");
  return [method, path.replace(/:(\w+)/g, (_, name: string) => params[name] ?? "")] as const;
};

/** Sends `route` as `user` against `owner`'s items, and returns the status and the body text. */
async function send(route: string, user: Seeded, owner: Seeded, other: Seeded) {
  const spec = CASES[route] as Case;
  const [method, path] = fill(route, spec.params(owner));
  const res = await as(user, method, path, { body: spec.body?.(owner, other) });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  const migrations = (workerEnv as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
  await applyD1Migrations(db, migrations);
  // The registry is module state: register once, however often the file's suites run.
  if (!builtinTools.get(TOOL)) {
    const inputSchema = { type: "object" as const };
    const manifest = {
      name: TOOL,
      description: "A probe.",
      inputSchema,
      destinations: [],
      scopes: [],
    };
    builtinTools.register({ manifest: { ...manifest, riskClass: "consequential" } });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the route table (AC7)", () => {
  it("has an isolation case for every protected route that takes a param, and no stale one", () => {
    expect(idRoutes.length).toBeGreaterThan(0);
    expect([...idRoutes].sort()).toEqual(Object.keys(CASES).sort());
  });
});

describe.each([
  { who: "B against A (AC1)", attacker: "b", victim: "a" },
  { who: "A, the owner, against a second user (AC5)", attacker: "a", victim: "b" },
] as const)("$who", ({ attacker: from, victim: to }) => {
  let attacker: Seeded;
  let victim: Seeded;
  beforeEach(async () => {
    const users = await seedBoth();
    [attacker, victim] = [users[from], users[to]];
    // A provider Test would call the provider: answer it here, so nothing leaves the test.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
  });

  it("gets 404 for the victim's ID on every ID route, and changes nothing of theirs", async () => {
    for (const route of idRoutes) {
      const before = await snapshot(victim);
      const { status, text } = await send(route, attacker, victim, attacker);
      expect([route, status]).toEqual([route, CASES[route]?.status ?? 404]);
      expect([route, leaked(victim, text)]).toEqual([route, []]);
      expect([route, await snapshot(victim)]).toEqual([route, before]);
    }
    expect(leaked(victim, await snapshot(attacker, { audit: false }))).toEqual([]);
  });

  it("gets the route's own answer for the owner's own ID, so each 404 above means something", async () => {
    for (const route of idRoutes) {
      const { status } = await send(route, victim, victim, victim);
      expect([route, status]).toEqual([route, CASES[route]?.own]);
    }
    // The owner was signed in throughout: no route above answered for a revoked session.
    expect((await as(victim, "GET", "/api/me")).status).toBe(200);
  });

  it("never sees the victim's items in a list", async () => {
    expect(lists).toEqual(expect.arrayContaining(["GET /api/conversations", "GET /api/me"]));
    for (const route of lists) {
      const [, path = ""] = route.split(" ");
      const text = await (await as(attacker, "GET", path)).text();
      expect([route, leaked(victim, text)]).toEqual([route, []]);
    }
    // The same lists do carry the user's own items.
    const own = async (path: string) => (await as(victim, "GET", path)).text();
    expect(await own("/api/conversations")).toContain(victim.conversation);
    expect(await own("/api/artifacts")).toContain(victim.artifact);
    expect(await own("/api/sessions")).toContain(victim.session);
    expect(await own("/api/settings")).toContain(victim.provider);
    expect(await own("/api/settings/grants")).toContain(victim.grant);
  });

  it("can't use the victim's IDs in a body or a query either", async () => {
    const before = await snapshot(victim);
    const pick = { provider: victim.provider, model: "gpt-4o" };
    const roles = await as(attacker, "PUT", "/api/settings/roles", { body: { chat: pick } });
    expect(roles.status).toBe(400);
    const own = `/api/conversations/${attacker.conversation}/model`;
    expect((await as(attacker, "PUT", own, { body: pick })).status).toBe(400);
    const config = (query: string) => as(attacker, "GET", `/api/attachments/config${query}`);
    const byProvider = await (await config(`?provider=${victim.provider}`)).json();
    expect(byProvider).toMatchObject({ model: null });
    // The victim's conversation falls back to the attacker's own Chat role, as a missing one does.
    const byConversation = await (await config(`?conversationId=${victim.conversation}`)).text();
    expect(byConversation).toBe(await (await config("")).text());
    expect(await snapshot(victim)).toEqual(before);
    expect(leaked(victim, await snapshot(attacker, { audit: false }))).toEqual([]);
  });
});
