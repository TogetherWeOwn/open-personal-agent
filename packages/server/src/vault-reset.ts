// SPDX-License-Identifier: Apache-2.0
// The user's way back when their saved keys can't be opened any more (crypto review C-1): a lost
// or regenerated master key, or the previous master key deleted before a rotation finished. Nothing
// resets on its own; a key that is only missing for a moment must not cost the user their secrets.
import { resetUser, userState, type UserScope as VaultScope } from "@opa/vault";
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { verifyStepUp } from "./step-up";

const CALLER = "vault-reset";

export const vaultRoutes = new Hono<AppEnv>();

vaultRoutes.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.env.VAULT) return next();
  return c.json({ error: "vault_unavailable" }, 503);
});

/** Whether the user's saved keys open: `reset_required` is when the settings offer the reset. */
vaultRoutes.get("/", async (c) => {
  const scope = c.var.session.scope as unknown as VaultScope;
  return c.json({ state: await userState(c.env.VAULT as NonNullable<typeof c.env.VAULT>, scope) });
});

/**
 * Deletes the user's DEK and every secret of theirs, so they can enter their keys again. Needs
 * `confirm: "reset"` and a step-up for `vault.reset`, and only runs when nothing of theirs opens.
 */
vaultRoutes.post("/reset", async (c) => {
  const body = await c.req.json().catch(() => null);
  // The step-up is spent first, so an assertion is good for one request whatever it asks.
  if (!(await verifyStepUp(c, "vault.reset", body?.credential))) {
    return c.json({ error: "step_up_required" }, 401);
  }
  if (body?.confirm !== "reset") return c.json({ error: "confirm_required" }, 400);
  const vault = c.env.VAULT as NonNullable<typeof c.env.VAULT>;
  const scope = c.var.session.scope as unknown as VaultScope;
  const code = await resetUser(vault, scope, { caller: CALLER }).then(
    () => null,
    (error) => (error as { code?: unknown }).code,
  );
  if (code === null) return c.body(null, 204);
  if (code === "reset_refused") return c.json({ error: "reset_not_required" }, 409);
  if (code === "reset_conflict") return c.json({ error: "reset_conflict" }, 409);
  return c.json({ error: "vault_unavailable" }, 503);
});
