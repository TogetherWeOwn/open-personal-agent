// SPDX-License-Identifier: Apache-2.0
// The test app: a migrated database, the Worker's env, a cookie-keeping browser and a claim.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";
import { app } from "../../src/app";
import type { Env } from "../../src/env";
import { SoftPasskey } from "./softauthn";

export const ORIGIN = "https://opa.test";
export const TOKEN = "setup-token-0123456789abcdefghijklmn";
const base = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
export const env: Env = {
  ...base,
  OPA_MASTER_KEY: "test-master-key",
  OPA_SESSION_SECRET: "test-session-secret",
  OPA_SETUP_TOKEN: TOKEN,
  ASSETS: { fetch: async () => new Response("spa") } as unknown as Fetcher,
};
export const db = env.DB;
export const TABLES =
  "setup_state used_setup_tokens sessions passkeys recovery_codes webauthn_challenges conversations audit_log users";

/** Migrates once, then empties the tables before each test. */
export function freshDatabase() {
  beforeAll(() => applyD1Migrations(db, base.TEST_MIGRATIONS));
  beforeEach(async () => {
    await db.batch(TABLES.split(" ").map((table) => db.prepare(`DELETE FROM ${table}`)));
  });
}

export const count = (table: string, where = "1") =>
  db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).first<number>("n");

export const passkey = () => new SoftPasskey("opa.test", ORIGIN);

type Options = { options: { challenge: string } };

/** A tiny browser: keeps cookies and sends its Origin on writes. */
export class Browser {
  cookies = new Map<string, string>();
  setCookies: string[] = [];
  constructor(readonly bindings: Env = env) {}

  async req(
    path: string,
    init: { body?: unknown; origin?: string | null; method?: string } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (method !== "GET" && origin !== null) headers.origin = origin;
    const body = init.body === undefined ? null : JSON.stringify(init.body);
    const res = await app.request(`${ORIGIN}${path}`, { method, headers, body }, this.bindings);
    this.setCookies = res.headers.getSetCookie();
    for (const cookie of this.setCookies) {
      const [name = "", value = ""] = (cookie.split(";")[0] ?? "").split("=");
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  options(token: string) {
    return this.req("/setup/options", { body: { token } });
  }

  /** Runs both setup steps with a new passkey and returns the final response. */
  async setup(token: string, opts: { uv?: boolean; origin?: string; key?: SoftPasskey } = {}) {
    const res = await this.options(token);
    if (res.status !== 200) return res;
    const { options } = await res.json<Options>();
    const credential = await (opts.key ?? passkey()).create(options, opts);
    return this.req("/setup", { body: { token, credential } });
  }

  /** Runs both login steps with `key` and returns the final response. */
  async login(key: SoftPasskey, opts: { uv?: boolean; origin?: string } = {}) {
    const res = await this.req("/api/auth/login/options", { body: {} });
    if (res.status !== 200) return res;
    const { options } = await res.json<Options>();
    return this.req("/api/auth/login", { body: { credential: await key.get(options, opts) } });
  }
}

/** Claims the deployment. Returns the owner's passkey and the browser that holds a session. */
export async function claim() {
  const key = passkey();
  const browser = new Browser();
  const res = await browser.setup(TOKEN, { key });
  if (res.status !== 200) throw new Error(`claim failed: ${res.status}`);
  const owner = (await db.prepare("SELECT id FROM users").first<string>("id")) as string;
  return { key, browser, owner };
}
