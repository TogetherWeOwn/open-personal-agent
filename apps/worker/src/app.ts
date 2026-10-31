// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import type { Env } from "./env";
import { checkHealth } from "./health";
import { finishSetupPage } from "./setup-page";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", async (c) => {
  const health = await checkHealth(c.env);
  c.header("Cache-Control", "no-store");
  return c.json(health, health.status === "ok" ? 200 : 503);
});

// Secret routes fail closed when the vault didn't start: no fallback key and no plaintext mode
// (ADR 0010 D4.1 #7).
app.use("/api/secrets/*", async (c, next) => {
  if (c.env.VAULT) return next();
  c.header("Cache-Control", "no-store");
  return c.json({ error: "vault_unavailable" }, 503);
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

// Never send a stack trace or error message to the client.
app.onError((_err, c) => c.json({ error: "internal_error" }, 500));
