// SPDX-License-Identifier: Apache-2.0
// Redeeming a recovery code (M2-10b, ADR 0010 D2). A code and a new passkey sign the owner back
// in, in the same two steps as `/setup`. The code is burned in the D1 batch that adds the passkey
// and the session, so two browsers racing with one code can't both win. A recovery ends every
// session and keeps the passkeys; the answer lists them so the owner can spot one they don't know.
// Every attempt is audited. Denied rows carry a keyed hash of the address, and they are the limit.
import { systemStore } from "@opa/db/system";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv } from "./env";
import { checkHealth } from "./health";

/** Denied attempts one address may make in its window. */
export const ADDRESS_LIMIT = 5;
const ADDRESS_WINDOW_MS = 15 * 60_000;
/** Denied attempts from all addresses before code recovery locks for the rest of the window. */
export const DEPLOYMENT_LIMIT = 20;
const DEPLOYMENT_WINDOW_MS = 60 * 60_000;
/** Longer than any typed code, spaces and dashes included; anything longer is hashed as empty. */
const MAX_CODE_LENGTH = 100;

type Code = { id: string; owner: string; codeHash: string };
type Body = { code?: unknown; credential?: unknown };

/**
 * The checks both steps share, in order: a configured deployment, the rate limits, then the code.
 * A wrong, used and malformed code take the same path: hash, compare with every unused code,
 * audit. Returns the matching code, or the error response.
 */
async function redeemable(c: Context<AppEnv>): Promise<Response | (Code & { body: Body })> {
  if ((await checkHealth(c.env)).status === "setup_required") {
    return c.json({ error: "setup_required" }, 503);
  }
  const store = systemStore(c.env);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  // Keyed, so the audit log never holds an address, nor a hash that can be brute-forced back.
  const address = await auth.sha256(`${c.env.OPA_SESSION_SECRET}\n${ip}`);
  const now = Date.now();
  const failures = await store.recovery.failures(
    address,
    now - DEPLOYMENT_WINDOW_MS,
    now - ADDRESS_WINDOW_MS,
  );
  if (!failures || failures.address >= ADDRESS_LIMIT || failures.deployment >= DEPLOYMENT_LIMIT) {
    await store.audit(null, "recovery.code", "auth", "limited", address);
    return c.json({ error: "rate_limited" }, 429);
  }

  const body: Body = (await c.req.json().catch(() => null)) ?? {};
  const typed =
    typeof body.code === "string" && body.code.length <= MAX_CODE_LENGTH ? body.code : "";
  const codeHash = await auth.hashRecoveryCode(typed);
  let match: Code | null = null;
  // No early exit: the time taken depends on how many codes are left, never on which one matched.
  for (const row of await store.recovery.unused()) {
    if ((await auth.secretsEqual(row.code_hash, codeHash)) && !match) {
      match = { id: row.id, owner: row.user_id, codeHash };
    }
  }
  if (!match) {
    await store.audit(null, "recovery.code", "auth", "denied", address);
    return c.json({ error: "invalid_code" }, 403);
  }
  return { ...match, body };
}

export const recover = new Hono<AppEnv>();

/** Step 1: a valid code gets registration options for a new passkey on the owner's account. */
recover.post("/options", async (c) => {
  const code = await redeemable(c);
  if (code instanceof Response) return code;
  const store = systemStore(c.env);
  const options = await auth.registrationOptions(c.req.url, code.owner);
  // The challenge carries the code's hash, so step 2 must present the same code.
  const cookie = await auth.putChallenge(
    store,
    "recovery_code",
    options.challenge,
    code.owner,
    code.codeHash,
  );
  await store.audit(code.owner, "recovery.code", "auth", "allowed");
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  return c.json({ options });
});

/** Step 2: verify the passkey, then burn the code and sign in, in one batch. */
recover.post("/", async (c) => {
  const code = await redeemable(c);
  if (code instanceof Response) return code;
  const store = systemStore(c.env);
  const cookie = getCookie(c, auth.CHALLENGE_COOKIE);
  const challenge = await auth.takeChallenge(store, cookie, "recovery_code", code.codeHash);
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  if (!challenge || challenge.user_id !== code.owner) {
    return c.json({ error: "no_challenge" }, 400);
  }

  const { credential } = code.body;
  const passkey = await auth.verifyPasskey(c.req.url, credential, challenge.challenge, code.owner);
  if (!passkey) return c.json({ error: "not_verified" }, 400);

  const session = await auth.newSession(code.owner);
  const redemption = { codeId: code.id, passkey, session: session.row, now: Date.now() };
  try {
    await store.recovery.redeem(redemption);
  } catch {
    // Another browser used the same code first. The owner's race doesn't count towards the limit.
    await store.audit(code.owner, "recovery.code", "auth", "conflict");
    return c.json({ error: "invalid_code" }, 403);
  }

  // The code is spent and the old sessions are gone, so the new session goes out whatever
  // happens next. The count and the list are best-effort: null if they can't be read.
  const maxAge = auth.SESSION_ABSOLUTE_MS / 1000;
  setCookie(c, auth.SESSION_COOKIE, session.cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  c.header("Cache-Control", "no-store");
  const [left, passkeys] = await Promise.all([
    store.recovery.unused().catch(() => null),
    store.recovery.passkeys(code.owner).catch(() => null),
  ]);
  return c.json({
    codesLeft: left?.length ?? null,
    passkeys:
      passkeys?.map((p) => ({
        createdAt: p.created_at,
        lastUsedAt: p.last_used_at,
        synced: p.backed_up === 1,
        current: p.id === passkey.id,
      })) ?? null,
  });
});
