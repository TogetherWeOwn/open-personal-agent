// SPDX-License-Identifier: Apache-2.0
import { createRepository } from "@opa/db/repository";
import { log } from "@opa/log";
import { Hono } from "hono";
import { chatRoutes } from "./chat";
import type { AppEnv } from "./env";
import { checkHealth } from "./health";
import { exactOrigin, securityHeaders } from "./security";
import { authRoutes, sessionGuard, sessionRoutes } from "./session";
import { claimGuard, setup, setupOpen } from "./setup";
import { finishSetupPage } from "./setup-page";

/** The routes both runtimes serve. `createApp` puts them behind the guards. */
const shared = new Hono<AppEnv>();

shared.get("/api/health", async (c) => {
  const health = await checkHealth(c.env);
  c.header("Cache-Control", "no-store");
  return c.json(health, health.status === "ok" ? 200 : 503);
});

// Secret routes fail closed when the vault didn't start: no fallback key and no plaintext mode
// (ADR 0010 D4.1 #7).
shared.use("/api/secrets/*", async (c, next) => {
  if (c.env.VAULT) return next();
  c.header("Cache-Control", "no-store");
  return c.json({ error: "vault_unavailable" }, 503);
});

// The SPA's setup page reads the token from the URL fragment and POSTs it to the routes below.
shared.get("/setup", async (c) => {
  const health = await checkHealth(c.env);
  c.header("Cache-Control", "no-store");
  if (health.status === "setup_required") {
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.html(finishSetupPage(health), 503);
  }
  if (!(await setupOpen(c.env))) return c.json({ error: "already_claimed" }, 403);
  return c.env.ASSETS.fetch(c.req.raw);
});

shared.route("/setup", setup);
shared.route("/api/auth", authRoutes);
shared.route("/api/sessions", sessionRoutes);
shared.route("/api", chatRoutes);

/** Who is signed in; the SPA calls it to decide between the login page and the app. */
shared.get("/api/me", async (c) => {
  const user = await createRepository(c.env).forUser(c.var.session.scope).profile();
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ id: user.id, displayName: user.displayName, role: user.role });
});

/**
 * The app, with `extra` mounted at `/api` behind the same guards. The Worker passes the routes
 * that need its Durable Objects (worker-app.ts); apps/node, which can't load them, passes none.
 */
export function createApp(extra?: Hono<AppEnv>) {
  const app = new Hono<AppEnv>();
  // Workers invocation logs are off (wrangler.jsonc), so this is the request log. It records the
  // route pattern, never the URL: a query string can carry a secret (ADR 0010 D11).
  app.use(async (c, next) => {
    const start = Date.now();
    await next();
    const fields = { method: c.req.method, route: c.req.routePath, status: c.res.status };
    log.info("request", { ...fields, durationMs: Date.now() - start });
  });
  app.use(securityHeaders);
  app.use(exactOrigin);
  app.use(claimGuard);
  app.use(sessionGuard);

  app.route("/", shared);
  if (extra) app.route("/api", extra);
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  // Never send a stack trace or error message to the client, and log only the error's class name.
  app.onError((err, c) => {
    log.error("request.error", {
      method: c.req.method,
      route: c.req.routePath,
      errorName: err.name,
    });
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}

export const app = createApp();
