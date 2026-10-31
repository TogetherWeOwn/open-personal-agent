// SPDX-License-Identifier: Apache-2.0
import { log } from "@opa/log";
import { Hono } from "hono";
import type { Env } from "./env";
import { checkHealth } from "./health";
import { exactOrigin, securityHeaders } from "./security";
import { finishSetupPage } from "./setup-page";

export const app = new Hono<{ Bindings: Env }>();

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

app.get("/api/health", async (c) => {
  const health = await checkHealth(c.env);
  c.header("Cache-Control", "no-store");
  return c.json(health, health.status === "ok" ? 200 : 503);
});

// The claim flow (M2-09) takes over `/setup` once the deployment is ready; until then the SPA
// serves it.
app.get("/setup", async (c) => {
  const health = await checkHealth(c.env);
  if (health.status !== "setup_required") return c.env.ASSETS.fetch(c.req.raw);
  c.header("Cache-Control", "no-store");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  return c.html(finishSetupPage(health), 503);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

// Never send a stack trace or error message to the client, and log only the error's class name.
app.onError((err, c) => {
  log.error("request.error", { method: c.req.method, route: c.req.routePath, errorName: err.name });
  return c.json({ error: "internal_error" }, 500);
});
