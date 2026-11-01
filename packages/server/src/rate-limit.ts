// SPDX-License-Identifier: Apache-2.0
// The coarse per-address limit on the routes that answer without a session (ADR 0010 D10,
// security review M-2 and L-1). It runs before the claim and session guards, so a request over
// the limit costs no D1, R2 or Durable Object call. The binding is eventually consistent, so it
// bounds cost, not spend: per-user turn and spend limits live in the user's assistant.
import { log } from "@opa/log";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { clientIp } from "./security";

/** `/api/health`, `/setup*`, and the login and recovery-code steps, with any method. */
const LIMITED = /^\/(?:api\/health\/?$|setup(?:\/|$)|api\/auth\/(?:login|recover)(?:\/|$))/;

export const publicRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const limiter = c.env.PUBLIC_LIMIT;
  if (!limiter || !LIMITED.test(c.req.path)) return next();
  // A failing limiter lets the request through: it must never lock the owner out.
  const { success } = await limiter.limit({ key: clientIp(c) }).catch(() => ({ success: true }));
  if (success) return next();
  log.warn("request.rejected", {
    reason: "rate_limit",
    method: c.req.method,
    route: c.req.routePath,
  });
  c.header("Cache-Control", "no-store");
  c.header("Retry-After", "60");
  return c.json({ error: "rate_limited" }, 429);
};
