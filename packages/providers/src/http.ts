// SPDX-License-Identifier: Apache-2.0
// What every fetch adapter does the same way: checks the base URL before a key can go to it, and
// maps a failed HTTP response to a normalized error.
import type { ModelErrorCode, ModelEvent } from "@opa/core";
import { error } from "./chat-chunks";
import { canonicalOrigin } from "./credential-binding";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** Whether `hostname` (a `URL`'s, so IPv6 in brackets) names this machine. */
export const isLoopbackHost = (hostname: string) => LOOPBACK.test(hostname);

/**
 * The base URL without trailing slashes. Throws when it has a query or fragment, or when it would
 * send a key over plain HTTP to anything but loopback (or, with `privateHttp`, a private host
 * that the caller's `fetch` guards).
 */
export function apiBase(baseUrl: string, apiKey: string | undefined, privateHttp = false): string {
  canonicalOrigin(baseUrl);
  const url = new URL(baseUrl);
  if (url.search || url.hash) throw new Error("Base URL must not have a query or fragment");
  // Over plain HTTP a key is readable in transit, so only loopback servers may take one.
  const plainOk = privateHttp || LOOPBACK.test(url.hostname);
  if (apiKey && url.protocol === "http:" && !plainOk) {
    throw new Error("A base URL that takes an API key must use https");
  }
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return url.origin + path;
}

/** Replaces every copy of the key in text that came back from the provider. */
export const redactor = (apiKey: string | undefined) => (text: string) =>
  apiKey ? text.split(apiKey).join("[redacted]") : text;

/** OpenAI and Anthropic both put the reason in `error.message`. */
export async function httpError(
  res: Response,
  redact: (text: string) => string,
): Promise<ModelEvent> {
  if (res.status >= 300 && res.status < 400) {
    return error(
      "bad_request",
      "The provider redirected the request; check the base URL",
      res.status,
    );
  }
  const code: ModelErrorCode =
    res.status === 401 || res.status === 403
      ? "auth"
      : res.status === 429
        ? "rate_limited"
        : res.status >= 500
          ? "upstream"
          : "bad_request";
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    // Not JSON; the status says enough.
  }
  return error(code, detail ? redact(detail).slice(0, 300) : `HTTP ${res.status}`, res.status);
}
