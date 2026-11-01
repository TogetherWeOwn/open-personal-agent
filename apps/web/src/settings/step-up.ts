// SPDX-License-Identifier: Apache-2.0
// The shared 5-minute account step-up (M3-19 AC1-2): a passkey ceremony that stamps this
// session only, for the account actions (loosening a tool, credential changes, export and
// deletion). One fresh ceremony, then the guarded call runs; a stale `step_up_required`
// retries the ceremony once without asking.
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";

/** Runs the session step-up ceremony; resolves when this session is stepped up. */
export async function ensureAccountStepUp(): Promise<void> {
  const res = await fetch("/api/auth/step-up/session/options", { method: "POST" });
  const json = (await res.json().catch(() => ({}))) as {
    options?: PublicKeyCredentialRequestOptionsJSON;
    error?: string;
  };
  if (!res.ok || !json.options) throw new Error(json.error ?? "unknown");
  const credential = await startAuthentication({ optionsJSON: json.options });
  const verify = await fetch("/api/auth/step-up/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!verify.ok)
    throw new Error(((await verify.json().catch(() => ({}))) as { error?: string }).error);
}

/**
 * Runs `fn`, stepping up first when the server says the session needs it. A guarded call that
 * answers 403 `step_up_required` gets one fresh ceremony and one retry; anything else rejects
 * with the server's error code.
 */
export async function withAccountStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as Error).message !== "step_up_required") throw e;
    await ensureAccountStepUp();
    return fn();
  }
}
