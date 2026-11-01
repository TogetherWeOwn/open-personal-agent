// SPDX-License-Identifier: Apache-2.0
// The way back when the user's saved keys can't be opened any more (TWO-650, crypto review C-1):
// a lost or regenerated master key. Resetting deletes every saved key and secret of theirs, so
// the panel says so before anything happens, and the server asks for a passkey first.
import { useState } from "react";
import { Button, Heading } from "react-aria-components";
import { cancelled } from "../auth/ui";
import { resetVault } from "../models/settings-api";

const primary =
  "min-h-11 self-start rounded-lg bg-danger px-4 font-medium text-accent-contrast data-disabled:opacity-50 data-pressed:opacity-90";

const ERRORS: Record<string, string> = {
  step_up_required: "Your passkey couldn't be checked, so nothing was deleted. Try again.",
  reset_conflict: "The server was changing its master key at the same moment. Try again.",
  vault_unavailable:
    "The server's master key isn't available right now, so nothing was deleted. Try again later, or ask whoever runs this server.",
};

interface Props {
  /** The keys are gone: show the key entry form again. */
  onReset: () => void | Promise<void>;
  /** The server says the keys open after all (`reset_not_required`): check the state again. */
  onRefresh: () => void | Promise<void>;
}

export function VaultReset({ onReset, onRefresh }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reset = async () => {
    setBusy(true);
    setError("");
    const failure = await resetVault().then(
      () => null,
      (e: unknown) => e as Error,
    );
    setBusy(false);
    if (!failure) return onReset();
    if (failure.message === "reset_not_required") return onRefresh();
    setError(
      cancelled(failure)
        ? "The passkey check was cancelled, so nothing was deleted."
        : (ERRORS[failure.message] ?? "That didn't work, and nothing was deleted. Try again."),
    );
  };

  return (
    <section
      aria-labelledby="vault-reset-heading"
      data-testid="vault-reset"
      className="flex flex-col gap-3 rounded-xl border-2 border-danger bg-surface-raised p-4"
    >
      <Heading level={3} id="vault-reset-heading" className="text-lg font-semibold">
        Your saved keys can't be opened
      </Heading>
      <p>
        This server's master key has changed or was lost, so it can no longer read the API keys you
        saved. They can't be recovered.
      </p>
      <p>
        <strong>Resetting deletes all of your saved keys and secrets.</strong> Your chats and
        settings stay. Afterwards, enter each provider's API key again.
      </p>
      <p className="text-sm text-text-muted">You'll confirm with your passkey.</p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <Button className={primary} isDisabled={busy} onPress={() => void reset().catch(() => {})}>
        {busy ? "Resetting…" : "Delete saved keys and reset"}
      </Button>
    </section>
  );
}
