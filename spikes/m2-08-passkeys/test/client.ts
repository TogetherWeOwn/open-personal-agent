// SPDX-License-Identifier: Apache-2.0
import { exports } from "cloudflare:workers";

export const ORIGIN = "https://opa.test";

// A tiny browser: keeps cookies, sends Origin on writes.
export class Browser {
  jar = new Map<string, string>();
  lastSetCookie: string[] = [];
  async req(path: string, init: { method?: string; body?: unknown; origin?: string } = {}) {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    if (method !== "GET") headers.origin = init.origin ?? ORIGIN;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await exports.default.fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    this.lastSetCookie = res.headers.getSetCookie();
    for (const c of this.lastSetCookie) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const v = kv.slice(i + 1);
      if (v === "" || /max-age=0/i.test(c)) this.jar.delete(kv.slice(0, i));
      else this.jar.set(kv.slice(0, i), v);
    }
    return res;
  }
}
