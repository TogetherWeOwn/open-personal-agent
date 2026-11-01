// SPDX-License-Identifier: Apache-2.0
// The test app: a migrated database, the Worker's env, a cookie-keeping browser and a claim.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { newSession, SESSION_COOKIE } from "@opa/server/auth";
import { type AttestationFormat, SoftPasskey } from "@opa/server/test/softauthn";
import { beforeAll, beforeEach } from "vitest";
import type { Env } from "../../src/env";
import { workerApp as app } from "../../src/worker-app";

export const ORIGIN = "https://opa.test";
export const TOKEN = "setup-token-0123456789abcdefghijklmn";
const base = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };
/** Every test request comes from one address, so tests other than rate-limit.test.ts skip it. */
export const unlimited = { limit: async () => ({ success: true }) } as RateLimit;
export const env: Env = {
  ...base,
  PUBLIC_LIMIT: unlimited,
  VAULT: null,
  VAULT_STATUS: "ok",
  OPA_SESSION_SECRET: "test-session-secret",
  OPA_SETUP_TOKEN: TOKEN,
  ASSETS: { fetch: async () => new Response("spa") } as unknown as Fetcher,
};
export const db = env.DB;

/**
 * For `vi.waitFor` on what a Durable Object sends back over a socket. The pool runs every DO event
 * (each WebSocket message, `fetch`, alarm) through a wrapper that imports the Worker in the runner
 * object, and Vite's module runner asks the main vitest process on every import, even a cached
 * one. On a busy CI runner that process stalls for about a second, so one message can arrive
 * later than `vi.waitFor`'s default 1 s timeout.
 */
export const SOCKET_WAIT = { timeout: 10_000 };
export const TABLES =
  "approvals artifacts attachments audit_log conversations exports grants memories memory_links messages meters model_providers passkeys recovery_codes secrets sessions setup_state task_events task_steps tasks tool_overrides turn_states usage used_setup_tokens user_keys user_settings users webauthn_challenges";

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
  /** `ip` is sent as `CF-Connecting-IP`, as Cloudflare would. */
  constructor(
    readonly bindings: Env = env,
    readonly ip?: string,
  ) {}

  async req(
    path: string,
    init: { body?: unknown; origin?: string | null; method?: string } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = {
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (this.ip) headers["cf-connecting-ip"] = this.ip;
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
  async setup(
    token: string,
    opts: { uv?: boolean; origin?: string; fmt?: AttestationFormat; key?: SoftPasskey } = {},
  ) {
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
  const { recoveryCodes: codes } = await res.json<{ recoveryCodes: string[] }>();
  const owner = (await db.prepare("SELECT id FROM users").first<string>("id")) as string;
  return { key, browser, owner, codes };
}

/** Signs `userId` in without a passkey: a live `sessions` row, and the headers that carry it. */
export async function sessionHeaders(userId: string) {
  const { cookie, row } = await newSession(userId);
  await db
    .prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(row.id, row.userId, row.tokenHash, row.expiresAt)
    .run();
  return { cookie: `${SESSION_COOKIE}=${cookie}`, origin: ORIGIN };
}
