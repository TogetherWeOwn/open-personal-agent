// SPDX-License-Identifier: Apache-2.0
// M4-00a AC3: the credential partition, from both sides. A scratch app runs the production
// guard order — `claimGuard`, then `tokenGuardFor`, then `sessionGuard` — over two audience
// routes, the shape the M4-00b/00c routes will mount: a bearer for the route's expected
// audience is the only credential that opens it, and a bearer presented to a session route —
// or beside a session cookie — is a 401, never a session. Every denial is the same
// indistinguishable body, and no denial echoes the token.
import {
  type CapabilityAudience,
  mintCapabilityToken,
  revokeTaskTokens,
} from "@opa/db/capability-tokens";
import { computerStore } from "@opa/db/computers";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { SqlDatabase } from "@opa/db/system";
import { SESSION_COOKIE } from "@opa/server/auth";
import { sessionGuard, tokenGuardFor } from "@opa/server/session";
import { claimGuard } from "@opa/server/setup";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { claim, db, env, freshDatabase, ORIGIN } from "./helpers/app";

freshDatabase();

/** The scratch partition: one route per audience, as the 00b/00c routes will declare. */
const TABLE = new Map<string, CapabilityAudience>([
  ["GET /api/agent/upload", "artifact_upload"],
  ["POST /api/agent/proxy", "model_proxy"],
  ["GET /api/agent/:id", "artifact_upload"],
]);

/**
 * A scratch app with the partition mounted behind the production guard order. It cannot go
 * through `createApp`: that wires the production (empty-in-00a) route table, whose session
 * guard would reject the scratch bearers before the scratch table ever sees them.
 */
function scratch() {
  const probe = new Hono<AppEnv>();
  probe.use(claimGuard);
  probe.use(tokenGuardFor(TABLE));
  probe.use(sessionGuard);
  probe.get("/api/agent/upload", (c) => c.json({ ok: true, aud: c.var.capability?.aud ?? null }));
  probe.post("/api/agent/proxy", (c) => c.json({ ok: true, aud: c.var.capability?.aud ?? null }));
  probe.get("/api/agent/:id", (c) => c.json({ ok: true, aud: c.var.capability?.aud ?? null }));
  probe.get("/api/me", (c) => c.json({ ok: true, userId: c.var.session.userId }));
  probe.get("/api/health", (c) => c.json({ ok: true }));
  return probe;
}

let ids = 0;

/** The claimed owner with one task, and a mint for it. One claim per test: a second fails. */
async function ownerWithTask() {
  const { browser, owner } = await claim();
  const tag = `guard-${++ids}-${Date.now()}`;
  const scoped = createRepository(env).forUser(scopeFromSession({ userId: owner }));
  await scoped.chat.open(`c-${tag}`, "G");
  await scoped.tasks.create({
    id: `t-${tag}`,
    conversationId: `c-${tag}`,
    kind: "turn",
    mode: "background",
  });
  const computer = await computerStore(env).create(
    {
      userId: owner,
      taskId: `t-${tag}`,
      provider: "fake",
      profile: "host",
      providerComputerId: tag,
    },
    Date.now(),
  );
  const mint = (aud: CapabilityAudience) =>
    mintCapabilityToken(db as unknown as SqlDatabase, {
      userId: owner,
      taskId: `t-${tag}`,
      computerId: computer.id,
      aud,
    });
  return { owner, taskId: `t-${tag}`, mint, cookie: browser.cookies.get(SESSION_COOKIE) };
}

const get = async (
  app: ReturnType<typeof scratch>,
  path: string,
  init: RequestInit = {},
): Promise<Response> =>
  app.request(`${ORIGIN}${path}`, { headers: { origin: ORIGIN }, ...init }, env);

describe("the capability-token partition", () => {
  it("opens a token route only to a live bearer for its expected audience", async () => {
    const app = scratch();
    const { mint } = await ownerWithTask();
    const { token } = await mint("artifact_upload");
    const res = await get(app, "/api/agent/upload", {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aud: "artifact_upload" });

    // The same token on the other audience's route is a stranger.
    const crossed = await get(app, "/api/agent/proxy", {
      method: "POST",
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(crossed.status).toBe(401);
    expect(await crossed.json()).toEqual({ error: "unauthenticated" });
  });

  it.each([
    ["no header", {}],
    ["a session cookie alone", { cookie: true } as const],
    ["a malformed bearer", { authorization: "Bearer not-a-token" }],
    ["a forged bearer", { authorization: `Bearer ocap1_${"Q".repeat(43)}` }],
    ["both a cookie and a bearer", { cookie: true, authorization: "live" } as const],
  ])("answers 401 with the same body on %s", async (_label, credentials) => {
    const app = scratch();
    const { mint, cookie } = await ownerWithTask();
    const { token } = await mint("artifact_upload");
    const headers: Record<string, string> = { origin: ORIGIN };
    if ("authorization" in credentials)
      headers.authorization =
        credentials.authorization === "live" ? `Bearer ${token}` : credentials.authorization;
    if ("cookie" in credentials) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    const res = await get(app, "/api/agent/upload", { headers });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "unauthenticated" });
    // The denial never echoes the bearer, the cookie or the prefix.
    expect(body).not.toContain(token);
    expect(body).not.toContain("ocap1_");
  });

  it("answers 401 on a revoked token, and on a session route carrying a bearer", async () => {
    const app = scratch();
    const { mint, taskId, owner, cookie } = await ownerWithTask();
    const { token } = await mint("model_proxy");
    await revokeTaskTokens(db as unknown as SqlDatabase, taskId, owner, "task_cancelled");
    const res = await get(app, "/api/agent/proxy", {
      method: "POST",
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);

    // A live bearer on a session route is never a session.
    const { token: fresh } = await mint("model_proxy");
    const sessionRoute = await get(app, "/api/me", {
      headers: { origin: ORIGIN, authorization: `Bearer ${fresh}` },
    });
    expect(sessionRoute.status).toBe(401);
    expect(await sessionRoute.json()).toEqual({ error: "unauthenticated" });
    // ...even beside the session cookie it belongs to.
    const both = await get(app, "/api/me", {
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${fresh}`,
        cookie: `${SESSION_COOKIE}=${cookie}`,
      },
    });
    expect(both.status).toBe(401);
  });

  it("matches a parameterised token route by its registered pattern, not the concrete path", async () => {
    const app = scratch();
    const { mint } = await ownerWithTask();
    const { token } = await mint("artifact_upload");
    const res = await get(app, "/api/agent/123", {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aud: "artifact_upload" });
  });

  it("lets a non-bearer Authorization header beside a session cookie reach the session", async () => {
    const app = scratch();
    const { cookie } = await ownerWithTask();
    // A Basic-auth reverse proxy in front of a self-hosted deployment forwards its own
    // header; the session guard only denies the bearer scheme.
    const res = await get(app, "/api/me", {
      headers: {
        origin: ORIGIN,
        authorization: "Basic c2VsZi1ob3N0ZWQ6cHJveHk=",
        cookie: `${SESSION_COOKIE}=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it("leaves a public route unchanged when a bearer is sent", async () => {
    const app = scratch();
    const { mint } = await ownerWithTask();
    const { token } = await mint("tool_gateway");
    const bare = await get(app, "/api/health");
    const bearer = await get(app, "/api/health", {
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    expect(bare.status).toBe(200);
    expect(bearer.status).toBe(200);
  });
});
