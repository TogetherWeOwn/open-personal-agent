// SPDX-License-Identifier: Apache-2.0
// Step-up (crypto review C-1): a fresh passkey assertion, with user verification, for one
// destructive action on top of the session. The challenge is bound to the signed-in user and to
// the action, is good for one use within its TTL, and only the user's own passkeys can answer it.
import { type ChallengeKind, systemStore } from "@opa/db/system";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  generateAuthenticationOptions,
} from "@simplewebauthn/server";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as auth from "./auth";
import type { AppEnv } from "./env";
import { verifyAssertion } from "./session";

/** The actions a step-up can authorise, each with its own challenge kind. */
const ACTIONS = { "vault.reset": "step_up_vault_reset" } as const satisfies Record<
  string,
  ChallengeKind
>;
export type StepUpAction = keyof typeof ACTIONS;

const isAction = (value: unknown): value is StepUpAction =>
  typeof value === "string" && Object.hasOwn(ACTIONS, value);

export const stepUpRoutes = new Hono<AppEnv>();

/** A challenge for one of the signed-in user's passkeys, for the body's `action`. */
stepUpRoutes.post("/options", async (c) => {
  c.header("Cache-Control", "no-store");
  const action = (await c.req.json().catch(() => null))?.action;
  if (!isAction(action)) return c.json({ error: "invalid_action" }, 400);
  const { userId } = c.var.session;
  const store = systemStore(c.env);
  const options = await generateAuthenticationOptions({
    rpID: new URL(c.req.url).hostname,
    userVerification: "required",
    allowCredentials: (await store.passkeys.ofUser(userId)).map((p) => ({
      id: p.id,
      transports: (p.transports?.split(",").filter(Boolean) ?? []) as AuthenticatorTransport[],
    })),
  });
  const cookie = await auth.putChallenge(store, ACTIONS[action], options.challenge, userId);
  const maxAge = auth.CHALLENGE_TTL_MS / 1000;
  setCookie(c, auth.CHALLENGE_COOKIE, cookie, { ...auth.COOKIE_OPTIONS, maxAge });
  return c.json({ options });
});

/**
 * Consumes the request's step-up challenge for `action` and verifies `credential` against it.
 * True only for a live challenge issued to this session's user for this action, answered by one
 * of their own passkeys. Every outcome is audited.
 */
export async function verifyStepUp(
  c: Context<AppEnv>,
  action: StepUpAction,
  credential: unknown,
): Promise<boolean> {
  const { userId } = c.var.session;
  const store = systemStore(c.env);
  const challenge = await auth.takeChallenge(
    store,
    getCookie(c, auth.CHALLENGE_COOKIE),
    ACTIONS[action],
  );
  deleteCookie(c, auth.CHALLENGE_COOKIE, auth.COOKIE_OPTIONS);
  const response = credential as AuthenticationResponseJSON | undefined;
  const passkey =
    challenge?.user_id === userId
      ? await store.passkeys.get(typeof response?.id === "string" ? response.id : "")
      : null;
  const counter =
    passkey?.user_id === userId
      ? await verifyAssertion(c, passkey, response, challenge?.challenge ?? "")
      : null;
  if (!passkey || counter === null) {
    await store.audit(userId, "auth.step_up", "auth", "denied", action);
    return false;
  }
  await store.passkeys.steppedUp({
    passkeyId: passkey.id,
    userId,
    counter,
    action,
    now: Date.now(),
  });
  return true;
}
