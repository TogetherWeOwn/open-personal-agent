// SPDX-License-Identifier: Apache-2.0
// The rotation runner (crypto review C-1). While the previous master key is set, each scheduled tick
// re-keys a batch of the users still under it; the tick that moves the last one retires the epoch.
// Health then says to delete PREV. The Worker's cron and Node's timer both call it.
import { log } from "@opa/log";
import { retireEpoch, rewrap, vaultStatus } from "@opa/vault";
import type { Env } from "./env";

const CALLER = "vault-rotation";
/** Users re-keyed per tick: each is a few AES operations and one batch, well inside a cron's CPU. */
export const ROTATION_BATCH = 100;

export async function runRotation(env: Pick<Env, "VAULT">): Promise<void> {
  const vault = env.VAULT;
  if (!vault) return;
  try {
    const before = await vaultStatus(vault);
    if (before.rotation !== "pending" || before.remaining === 0) return;
    const { rewrapped } = await rewrap(vault, { caller: CALLER, limit: ROTATION_BATCH });
    // Retired only once a DEK under the new epoch stops old instances enrolling under PREV.
    const { rotation, previousEpoch } = await vaultStatus(vault);
    if (rotation === "complete" && previousEpoch !== null) {
      await retireEpoch(vault, previousEpoch, { caller: CALLER });
    }
    log.info("vault.rotation", { count: rewrapped, status: rotation });
  } catch (error) {
    // The next tick tries again; health keeps saying `pending` meanwhile. A vault error's code is
    // fixed text, such as `rewrap_conflict`.
    const { code } = error as { code?: unknown };
    log.error("vault.rotation", { reason: typeof code === "string" ? code : "error" });
  }
}
