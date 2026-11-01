// SPDX-License-Identifier: Apache-2.0
// Response headers, the exact-Origin check and sandboxed user content (ADR 0010 D2, D5, D6).
// Static assets get the same headers from apps/web/public/_headers; a test keeps the two equal.
import { log } from "@opa/log";
import type { Context, MiddlewareHandler } from "hono";

/** The web app: same-origin code only, and chat loads no remote resources (D6). */
export const APP_CSP =
  "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** JSON and other non-HTML responses load nothing. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const COMMON_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** Adds the headers a route didn't set, and strips CORS headers: the API is same-origin only. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.res.status === 101) return; // a WebSocket upgrade carries no document
  // Responses from fetch() and the ASSETS binding have immutable headers.
  c.res = new Response(c.res.body, c.res);
  const headers = c.res.headers;
  const html = headers.get("Content-Type")?.startsWith("text/html");
  const wanted = { ...COMMON_HEADERS, "Content-Security-Policy": html ? APP_CSP : API_CSP };
  for (const [name, value] of Object.entries(wanted))
    if (!headers.has(name)) headers.set(name, value);
  for (const name of [...headers.keys()])
    if (name.startsWith("access-control-")) headers.delete(name);
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The request's Origin is exactly this deployment's: the one Origin check (D2). */
export const sameOrigin = (c: Context) => c.req.header("Origin") === new URL(c.req.url).origin;

/**
 * Every state change must come from this exact origin, or none is accepted (D2). Same-site isn't
 * enough: `evil.example.workers.dev` is same-site with `opa.example.workers.dev`. There is no
 * exemption: a future webhook route must verify its signature before it is exempted here.
 */
export const exactOrigin: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const site = c.req.header("Sec-Fetch-Site") ?? "same-origin";
  if (sameOrigin(c) && site === "same-origin") return next();
  log.warn("request.rejected", { reason: "origin", method: c.req.method, route: c.req.routePath });
  return c.json({ error: "bad_origin" }, 403);
};

/** Shown inline, sandboxed. Everything else downloads as an opaque attachment. */
const PREVIEWABLE = /^(?:text\/(?:plain|html)|image\/(?:svg\+xml|png|jpeg|gif|webp))$/;

/**
 * User- or model-produced content (D5). CSP `sandbox` without `allow-same-origin` gives it an
 * opaque origin, so its scripts can't reach the session, the API or the app.
 */
export function userContent(body: BodyInit, contentType: string, filename: string): Response {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const inline = PREVIEWABLE.test(type);
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "download";
  const charset = type.startsWith("text/") ? "; charset=utf-8" : "";
  return new Response(body, {
    headers: {
      "Content-Type": inline ? type + charset : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Security-Policy":
        "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'",
      "Cache-Control": "private, no-store",
    },
  });
}
