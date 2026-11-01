// SPDX-License-Identifier: Apache-2.0
// Settings › Privacy & security (M3-19 AC2): the user's passkeys and recovery codes. Passkeys
// list with their names and dates, register on this signed-in session, rename freely, and
// remove only with the 5-minute account step-up: removal expires every pending approval in the
// same batch (M3-07 AC13), because a removed passkey is a possible-compromise signal. Recovery
// codes regenerate with the same step-up; rotation is routine, so approvals are untouched. Every
// change writes an audit row for the activity log (M3-19 AC3).
import { systemStore } from "@opa/db/system";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv } from "./env";
import { hasAccountStepUp } from "./session";

type Ctx = Context<AppEnv>;
const storeOf = (c: Ctx) => systemStore(c.env);

/** A passkey name after trimming: 1–64 characters, or null when the body didn't give one. */
const cleanName = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 64 ? name : null;
};

export const privacyRoutes = new Hono<AppEnv>();

privacyRoutes.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

/** The user's passkeys, newest first. Public keys never leave the store: no secrets here. */
privacyRoutes.get("/api/passkeys", async (c) => {
  const { userId } = c.var.session;
  const rows = await storeOf(c).passkeys.list(userId);
  return c.json({
    passkeys: rows.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
    })),
  });
});

/** Step 1 of adding a passkey: registration options for one of this session's user's devices. */
privacyRoutes.post("/api/passkeys/options", async (c) => {
  const { userId } = c.var.session;
  const options = await auth.registrationOptions(c.req.url, userId);
  const cookie = await auth.putChallenge(storeOf(c), "passkey_add", options.challenge, userId);
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  return c.json({ options });
});

/**
 * Step 2: verify the new passkey and store it. Body `{ credential, name? }`; the name defaults
 * to `Passkey N`. A challenge issued to another user, or answered twice, is `no_challenge`.
 */
privacyRoutes.post("/api/passkeys", async (c) => {
  const { userId } = c.var.session;
  const store = storeOf(c);
  const challenge = await auth.takeChallenge(
    store,
    getCookie(c, auth.CHALLENGE_COOKIE),
    "passkey_add",
  );
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  if (!challenge || challenge.user_id !== userId) return c.json({ error: "no_challenge" }, 400);
  const body = await c.req.json().catch(() => null);
  const passkey = await auth.verifyPasskey(
    c.req.url,
    body?.credential,
    challenge.challenge,
    userId,
  );
  if (!passkey) return c.json({ error: "not_verified" }, 400);
  const existing = await store.passkeys.list(userId);
  const name = cleanName(body?.name) ?? `Passkey ${existing.length + 1}`;
  try {
    await store.passkeys.add({ userId, passkey, name, now: Date.now() });
  } catch {
    return c.json({ error: "duplicate_passkey" }, 409);
  }
  return c.json({ passkey: { id: passkey.id, name } }, 201);
});

/** Renames one of the user's own passkeys. Body `{ name }`. Renaming needs no step-up. */
privacyRoutes.patch("/api/passkeys/:id", async (c) => {
  const { userId } = c.var.session;
  const name = cleanName((await c.req.json().catch(() => null))?.name);
  if (!name) return c.json({ error: "invalid_name" }, 400);
  if (!(await storeOf(c).passkeys.rename({ id: c.req.param("id"), userId, name, now: Date.now() })))
    return c.json({ error: "not_found" }, 404);
  return c.json({ passkey: { id: c.req.param("id"), name } });
});

/**
 * Removes one of the user's own passkeys. Needs the 5-minute account step-up, refuses the last
 * passkey (removing it would lock the account), and expires every pending approval in the
 * removal's own batch, with an `approval.expire_all` audit row (M3-07 AC13).
 */
privacyRoutes.delete("/api/passkeys/:id", async (c) => {
  const { userId } = c.var.session;
  if (!hasAccountStepUp(c.var.session)) return c.json({ error: "step_up_required" }, 403);
  const store = storeOf(c);
  if ((await store.passkeys.list(userId)).length <= 1)
    return c.json({ error: "last_passkey" }, 400);
  if (!(await store.passkeys.remove({ id: c.req.param("id"), userId, now: Date.now() })))
    return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/** How many of the user's recovery codes are still unused, so the page can nudge a rotation. */
privacyRoutes.get("/api/recovery-codes", async (c) => {
  const { userId } = c.var.session;
  return c.json({ remaining: await storeOf(c).recovery.remaining(userId) });
});

/**
 * Replaces the user's recovery codes with a fresh set, shown once in the response: they never
 * come back from the store. Needs the 5-minute account step-up, like removing a passkey.
 */
privacyRoutes.post("/api/recovery-codes/regenerate", async (c) => {
  const { userId } = c.var.session;
  if (!hasAccountStepUp(c.var.session)) return c.json({ error: "step_up_required" }, 403);
  const codes = Array.from({ length: auth.RECOVERY_CODE_COUNT }, auth.newRecoveryCode);
  const hashes = await Promise.all(codes.map(auth.hashRecoveryCode));
  await storeOf(c).recovery.regenerate({
    userId,
    codes: hashes.map((hash) => ({ id: auth.randomId(), hash })),
    now: Date.now(),
  });
  return c.json({ codes });
});
