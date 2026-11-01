// SPDX-License-Identifier: Apache-2.0
// Settings › Privacy & security copy (M3-19 AC2, m3-ux §3.9): the rows the page shows, a grant
// scope in plain words, and the compromise confirmations. Every confirmation for a
// compromise signal — removing a passkey, signing out everywhere — says that anything waiting
// on approval expires with it (M3-07 AC13). Kept apart from the page so the copy stays
// importable (and testable) without the DOM.

export interface PasskeyRow {
  id: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SessionRow {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  current: boolean;
}

export type GrantScope = "task" | "hour" | "destination";

export interface GrantRow {
  id: string;
  tool: string;
  scope: GrantScope;
  destination?: string | null;
  createdAt: number;
}

/** A standing grant's scope in plain words (m3-ux §3.9). */
export function grantScopeLabel(grant: GrantRow): string {
  switch (grant.scope) {
    case "task":
      return "This task only";
    case "hour":
      return "For an hour";
    case "destination":
      return grant.destination ? `Always for ${grant.destination}` : "Always for one place";
  }
}

/**
 * Removing a passkey is a compromise signal: the inline confirmation says anything waiting on
 * approval expires with it.
 */
export const removePasskeyConfirm = (name: string) =>
  `Remove “${name}”? You’ll still sign in with your other passkeys. Anything waiting on your approval expires with it, so nothing half-approved can run later.`;

/** Signing out everywhere ends every session and expires approvals, so its confirm says both. */
export const SIGN_OUT_EVERYWHERE_CONFIRM =
  "Sign out everywhere? Every session signs out, including this one, and you’ll sign back in. Anything waiting on your approval expires too.";

/**
 * Replacing recovery codes is a routine rotation, not a compromise signal: the old set dies but
 * waiting approvals stay. The confirmation says so, so it isn’t confused with the others.
 */
export const REGENERATE_CODES_CONFIRM =
  "Replace your recovery codes? The old set stops working at once. Anything waiting on your approval stays. Save the new set somewhere safe — it’s shown once.";

const ERRORS: Record<string, string> = {
  step_up_required: "Your confirmation expired. Try again.",
  last_passkey: "This is your only passkey. Add another one first, so you can’t lock yourself out.",
  not_found: "That was already removed. The list has been refreshed.",
  invalid_name: "Give it a name between 1 and 64 characters.",
  no_challenge: "The passkey ceremony expired. Try again.",
  not_verified: "Your device didn’t confirm. Try again.",
  duplicate_passkey: "That device is already added as one of your passkeys.",
};

/** The server's error code in plain words, or the fallback when it names nothing we say. */
export const privacyError = (e: unknown) =>
  ERRORS[(e as Error).message] ?? "That didn’t work. Try again.";
