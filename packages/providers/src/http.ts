// SPDX-License-Identifier: Apache-2.0
// What the keyed HTTP adapters share: base URL checks, the key's headers, redaction and the
// mapping of HTTP failures. Fetch only, no SDK (ADR 0006).
import type { ModelErrorCode, ModelEvent, ModelInfo } from "@opa/core";
import { aborted, error } from "./chat-chunks";
import { canonicalOrigin } from "./credential-binding";

export interface EndpointOptions {
  /** For example `https://api.openai.com/v1`. The key is only ever sent to this origin. */
  baseUrl: string;
  /** Optional: local servers often need none. */
  apiKey?: string;
  fetch?: typeof fetch;
  /**
   * The caller's `fetch` sends plain HTTP to private addresses only (Node's guard with
   * `OPA_ALLOW_PRIVATE_MODEL_HOSTS=1`), so a key may go to any `http:` base URL.
   */
  privateHttp?: boolean;
}

export interface Endpoint {
  /** Origin and path, without a trailing slash. */
  base: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  redact: (text: string) => string;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** Whether `hostname` (a `URL`'s, so IPv6 in brackets) names this machine. */
export const isLoopbackHost = (hostname: string) => LOOPBACK.test(hostname);

export function endpoint(options: EndpointOptions): Endpoint {
  canonicalOrigin(options.baseUrl);
  const url = new URL(options.baseUrl);
  if (url.search || url.hash) throw new Error("Base URL must not have a query or fragment");
  // Over plain HTTP a key is readable in transit, so only loopback servers may take one.
  const plainOk = options.privateHttp || LOOPBACK.test(url.hostname);
  if (options.apiKey && url.protocol === "http:" && !plainOk) {
    throw new Error("A base URL that takes an API key must use https");
  }
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  const { apiKey } = options;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return {
    base: url.origin + path,
    headers,
    fetch: options.fetch ?? fetch,
    redact: (text) => (apiKey ? text.split(apiKey).join("[redacted]") : text),
  };
}

/** `GET /models`, which the OpenAI-shaped APIs share. */
export async function listModels({ base, headers, fetch }: Endpoint): Promise<ModelInfo[]> {
  const res = await fetch(`${base}/models`, { headers, redirect: "manual" });
  if (!res.ok) throw new Error(`Listing models failed with HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.id }));
}

/** POSTs a streaming request: the response body, or the one error event that ends the call. */
export async function openStream(
  { base, headers, fetch, redact }: Endpoint,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array> | ModelEvent> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // A followed redirect would carry the key to another origin.
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
  } catch {
    return signal?.aborted ? aborted() : error("network", "Could not reach the provider");
  }
  if (!res.ok) return httpError(res, redact);
  return res.body ?? error("bad_response", "The provider returned no stream");
}

async function httpError(res: Response, redact: (text: string) => string): Promise<ModelEvent> {
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
