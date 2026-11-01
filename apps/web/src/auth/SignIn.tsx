// SPDX-License-Identifier: Apache-2.0
// Passkey sign-in (M2-10). The passkey is discoverable, so there is no username to type.
import {
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
} from "@simplewebauthn/browser";
import { useState } from "react";
import { Button } from "react-aria-components";
import { Alert, cancelled, type Failure, post, primary, Screen } from "./ui";

async function signIn(retried = false): Promise<void> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    "/api/auth/login/options",
  );
  const credential = await startAuthentication({ optionsJSON: options });
  try {
    await post("/api/auth/login", { credential });
  } catch (e) {
    // The challenge expired or its cookie was lost: one fresh ceremony, without asking.
    if ((e as Error).message === "no_challenge" && !retried) return signIn(true);
    throw e;
  }
}

export function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      // The app decides between onboarding and the chat.
      window.location.assign("/");
    } catch (e) {
      setError(
        cancelled(e)
          ? { text: "You didn't sign in: no passkey was used." }
          : (e as Error).message === "not_verified"
            ? { text: "That passkey doesn't belong to this assistant. Choose another one." }
            : { text: "Something went wrong while signing in. Try again." },
      );
      setBusy(false);
    }
  };

  return (
    <Screen title="Sign in">
      <p>Use the passkey you created when you set up your assistant.</p>
      <Alert failure={error} />
      <Button onPress={start} isDisabled={busy} className={`${primary} self-start`}>
        {error ? "Try again" : "Sign in with your passkey"}
      </Button>
      <details className="text-sm text-text-muted">
        <summary className="min-h-11 cursor-pointer content-center">Lost your passkey?</summary>
        <p>
          Whoever runs your server can set a new setup token. Then open{" "}
          <a href="/setup" className="text-accent underline underline-offset-2">
            the setup page
          </a>{" "}
          and enter it to recover your account with a new passkey.
        </p>
      </details>
    </Screen>
  );
}
