// SPDX-License-Identifier: Apache-2.0
import { createRepository } from "@opa/db/repository";
import { systemStore } from "@opa/db/system";
import { log } from "@opa/log";
import { Hono } from "hono";
import { artifactRoutes } from "./artifacts";
import { attachmentRoutes } from "./attachments";
import { chatRoutes } from "./chat";
import type { AppEnv, AppPorts } from "./env";
import { exportRoutes } from "./exports";
import { checkHealth, setupRequired } from "./health";
import { settings } from "./model-settings";
import { publicRateLimit } from "./rate-limit";
import { recover } from "./recover";
import { exactOrigin, securityHeaders } from "./security";
import { authRoutes, currentSession, sessionGuard, sessionRoutes } from "./session";
import { claimGuard, setup, setupPageState } from "./setup";
import { alreadySetUpPage, finishSetupPage, weakSetupTokenPage } from "./setup-page";
import { spendingRoutes } from "./spending";
import { stepUpRoutes } from "./step-up";
import { taskRoutes } from "./tasks";
import { toolSettings } from "./tool-settings";
import { usageRoutes } from "./usage";
import { vaultRoutes } from "./vault-reset";

/** The routes both runtimes serve. `createApp` puts them behind the guards. */
const shared = new Hono<AppEnv>();

shared.get("/api/health", async (c) => {
  const health = await checkHealth(c.env);
  c.header("Cache-Control", "no-store");
  const code = health.status === "ok" ? 200 : 503;
  // Before the claim, the deploy and the Finish setup page need the detail. After it, only a
  // signed-in user learns which checks failed or which secrets are missing. An unmigrated or
  // unreachable database counts as unclaimed, as in the claim guard.
  const claimed = await systemStore(c.env)
    .setup.isClaimed()
    .catch(() => false);
  if (claimed && !(await currentSession(c))) return c.json({ status: health.status }, code);
  return c.json(health, code);
});

// Secret routes fail closed when the vault didn't start: no fallback key and no plaintext mode
// (ADR 0010 D4.1 #7).
shared.use("/api/secrets/*", async (c, next) => {
  if (c.env.VAULT) return next();
  c.header("Cache-Control", "no-store");
  return c.json({ error: "vault_unavailable" }, 503);
});

shared.route("/api/settings/vault", vaultRoutes);
shared.route("/api/settings/spending", spendingRoutes);
shared.route("/api/settings", settings);
shared.route("/api/settings", toolSettings);

// The SPA's setup page reads the token from the URL fragment and POSTs it to the routes below.
shared.get("/setup", async (c) => {
  c.header("Cache-Control", "no-store");
  // Plain HTML with no script, for the states the SPA can't help with.
  const page = (html: string, status: 403 | 503) => {
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.html(html, status);
  };
  if (await setupRequired(c.env)) return page(finishSetupPage(await checkHealth(c.env)), 503);
  const state = await setupPageState(c.env);
  if (state === "weak_token") return page(weakSetupTokenPage(), 403);
  if (state === "closed") return page(alreadySetUpPage(), 403);
  return c.env.ASSETS.fetch(c.req.raw);
});

shared.route("/setup", setup);
shared.route("/api/auth/recover", recover);
shared.route("/api/auth/step-up", stepUpRoutes);
shared.route("/api/auth", authRoutes);
shared.route("/api/sessions", sessionRoutes);
shared.route("/api", chatRoutes);
shared.route("/api/attachments", attachmentRoutes);
shared.route("/api/exports", exportRoutes);
shared.route("/api/artifacts", artifactRoutes);
shared.route("/api/usage", usageRoutes);
shared.route("/api/tasks", taskRoutes);

/** Who is signed in; the SPA calls it to decide between the login page and the app. */
shared.get("/api/me", async (c) => {
  const user = await createRepository(c.env).forUser(c.var.session.scope).profile();
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ id: user.id, displayName: user.displayName, role: user.role });
});

/**
 * The app over a root's ports `P`, with `extra` mounted at `/api` behind the same guards. The
 * Worker passes the routes that need its Durable Objects (apps/worker/src/worker-app.ts);
 * apps/node, which has none, passes nothing. The ports arrive with each request, as Workers pass
 * the env to `fetch`.
 */
export function createApp<P extends AppPorts = AppPorts>(extra?: Hono<AppEnv<P>>) {
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
  app.use(publicRateLimit);
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
