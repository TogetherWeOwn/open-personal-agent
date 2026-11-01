// SPDX-License-Identifier: Apache-2.0
// Account deletion (M3-20 AC2–3, m3-ux Flow G §3.11): what goes away and what stays behind,
// the only-owner warning before the passkey ceremony, and the two-press delete. The preview
// loads with the screen and needs no step-up; the delete runs the passkey step-up and retries
// once, as starting an export does. On success the page reloads through the signed-out guards:
// the unclaimed first-run screen when nobody remains, the sign-in screen otherwise.
import { useCallback, useEffect, useState } from "react";
import { Heading } from "react-aria-components";
import { Button, Card, CardHeader } from "../ui";
import { deleteAccount, previewDeletion } from "./account-api";

const ERRORS: Record<string, string> = {
  step_up_required: "Confirm it's you with your passkey first, then try again.",
  delete_failed: "The account couldn't be deleted. Try again in a moment.",
};

export function DeleteAccount() {
  const [onlyOwner, setOnlyOwner] = useState<boolean | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    let cancelled = false;
    setPreviewFailed(false);
    previewDeletion().then(
      (preview) => !cancelled && setOnlyOwner(preview.isOnlyOwner),
      () => {
        if (!cancelled) setPreviewFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const remove = async () => {
    setDeleting(true);
    setError("");
    try {
      await deleteAccount();
      // The session died with the account: reload, and the guards show the first-run screen
      // when the deployment is unclaimed, the sign-in screen otherwise.
      window.location.replace("/");
    } catch (e: unknown) {
      setError(ERRORS[(e as Error).message] ?? "That didn't work. Try again in a moment.");
      setDeleting(false);
    }
  };

  return (
    <div data-testid="delete-account">
      <Card labelledBy="delete-account-heading">
        <CardHeader id="delete-account-heading" title="Delete your account" />
        <p>
          Removes your account and everything in it: your chats and messages, memories, tasks and
          their outputs, uploaded files and files made for you, settings and usage history, and your
          passkeys, sessions and encrypted data key.
        </p>
        <Heading level={4} className="text-sm font-semibold">
          What stays behind
        </Heading>
        <p className="text-sm text-text-muted">
          Time Travel backups for 30 days, your model providers&apos; own logs, and Workers Logs for
          7 days. Nothing else keeps your name.
        </p>
        {onlyOwner === null ? (
          previewFailed ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-danger">
                Couldn&apos;t check whether you&apos;re the only account.
              </p>
              <Button variant="secondary" onPress={() => void load()}>
                Try again
              </Button>
            </div>
          ) : (
            <p className="text-sm text-text-muted">Loading…</p>
          )
        ) : (
          onlyOwner && (
            <p role="note" className="text-sm">
              You&apos;re the only account on this deployment. Deleting it returns the app to its
              first-run screen, and claiming it again needs a fresh setup token — rotate SETUP_TOKEN
              on the server before anyone signs up again.
            </p>
          )
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">This can&apos;t be undone. Delete it all?</p>
            <Button variant="danger" isDisabled={deleting} onPress={() => void remove()}>
              {deleting ? "Deleting…" : "Yes, delete my account"}
            </Button>
            <Button variant="secondary" isDisabled={deleting} onPress={() => setConfirming(false)}>
              Keep my account
            </Button>
          </div>
        ) : (
          <div>
            <Button
              variant="danger"
              className="self-start"
              isDisabled={onlyOwner === null && !previewFailed}
              onPress={() => setConfirming(true)}
            >
              Delete your account
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
