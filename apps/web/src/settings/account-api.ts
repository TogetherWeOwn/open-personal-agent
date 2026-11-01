// SPDX-License-Identifier: Apache-2.0
// The account deletion client (M3-20 AC2–3, m3-ux §3.11): the preview the screen shows before
// the passkey ceremony, and the delete itself. Deleting is an account action: the first 403
// runs the passkey step-up and retries, once — the preview needs no step-up, so the screen
// can warn the only owner before asking for a passkey.
import { stepUpSession } from "./export-api";

export interface DeletionPreview {
  isOnlyOwner: boolean;
}

export interface DeletionResult {
  deleted: boolean;
  unclaimed: boolean;
}

const err = (body: unknown) => new Error((body as { error?: string }).error ?? "request_failed");

/**
 * The delete stays disabled until the preview names the only owner. A failed
 * preview leaves `onlyOwner` null, so the button stays off and "Try again" is
 * the only way forward — the only owner always sees the unclaimed warning
 * before the passkey ceremony.
 */
export function isDeleteDisabled(onlyOwner: boolean | null): boolean {
  return onlyOwner === null;
}

async function readError(res: Response): Promise<Error> {
  return err(await res.json().catch(() => ({})));
}

/** Whether deleting this account returns the deployment to the unclaimed first-run screen. */
export async function previewDeletion(): Promise<DeletionPreview> {
  const res = await fetch("/api/account");
  if (!res.ok) throw await readError(res);
  return (await res.json()) as DeletionPreview;
}

/** Deletes the account; the caller reloads through the signed-out guards on success. */
export async function deleteAccount(retried = false): Promise<DeletionResult> {
  const res = await fetch("/api/account", { method: "DELETE" });
  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "step_up_required" && !retried) {
      await stepUpSession();
      return deleteAccount(true);
    }
    throw err(body);
  }
  if (!res.ok) throw await readError(res);
  return (await res.json()) as DeletionResult;
}
