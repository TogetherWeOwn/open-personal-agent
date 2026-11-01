// SPDX-License-Identifier: Apache-2.0
// Recovery with a code (M2-10b): one of the codes saved at the claim and a new passkey sign the
// owner back in. The server ends every other session, keeps the old passkeys and lists them here,
// so the owner can tell whether someone else holds one.
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useState } from "react";
import { Button, Input, Label, TextField } from "react-aria-components";
import { Alert, cancelled, type Failure, input, post, primary, Screen } from "./ui";

interface Recovered {
  /** Null when the server signed the owner in but couldn't read these back. */
  codesLeft: number | null;
  passkeys:
    | { createdAt: number; lastUsedAt: number | null; synced: boolean; current: boolean }[]
    | null;
}

const FAILURES: Record<string, string> = {
  invalid_code: "That recovery code doesn't work. Each code works once.",
  rate_limited: "Too many codes were tried. Wait 15 minutes, then try again.",
};

async function redeem(code: string, retried = false): Promise<Recovered> {
  const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    "/api/auth/recover/options",
    { code },
  );
  const credential = await startRegistration({ optionsJSON: options });
  try {
    return await post<Recovered>("/api/auth/recover", { code, credential });
  } catch (e) {
    // The challenge expired or its cookie was lost: one fresh ceremony, without asking.
    if ((e as Error).message === "no_challenge" && !retried) return redeem(code, true);
    throw e;
  }
}

export function Recover() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [done, setDone] = useState<Recovered | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await redeem(code));
    } catch (e) {
      const text = FAILURES[(e as Error).message];
      setError({
        text: cancelled(e)
          ? "No passkey was created."
          : (text ?? "Something went wrong and no passkey was saved. Try again."),
      });
    } finally {
      setBusy(false);
    }
  };

  if (done) return <BackIn {...done} />;
  return (
    <Screen title="Use a recovery code">
      <p>
        Enter one of the recovery codes you saved when you set up your assistant. Then your device
        will ask for your fingerprint, face or screen lock to create a new passkey.
      </p>
      <TextField value={code} onChange={setCode} className="flex flex-col gap-1">
        <Label>Recovery code</Label>
        <Input className={input} autoComplete="off" spellCheck={false} />
      </TextField>
      <Alert failure={error} />
      <Button onPress={start} isDisabled={busy || !code.trim()} className={`${primary} self-start`}>
        {error ? "Try again" : "Create a new passkey"}
      </Button>
    </Screen>
  );
}

const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
// With the time, so two passkeys made on one day can be told apart.
const moment = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function BackIn({ codesLeft, passkeys }: Recovered) {
  return (
    <Screen title="You're back in">
      <p>
        You're signed in with a new passkey, and every other session was signed out.{" "}
        {codesLeft !== null && (
          <strong>
            {codesLeft === 1 ? "1 recovery code is" : `${codesLeft} recovery codes are`} left.
          </strong>
        )}
      </p>
      {passkeys ? (
        <p>These passkeys can sign in to your assistant. Check that you know each one.</p>
      ) : (
        <p>The list of your passkeys couldn't be loaded.</p>
      )}
      <ul aria-label="Passkeys" className="flex flex-col gap-2">
        {passkeys?.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the list never changes once shown
          <li key={i} className="rounded-lg bg-surface-sunken p-3">
            {p.current ? "This device, new" : `Created ${moment(p.createdAt)}`}
            <span className="block text-sm text-text-muted">
              {p.lastUsedAt ? `Last used ${day(p.lastUsedAt)}` : "Never used to sign in"}
              {p.synced && " · synced between devices"}
            </span>
          </li>
        ))}
      </ul>
      <Button className={`${primary} self-start`} onPress={() => window.location.assign("/")}>
        Continue
      </Button>
    </Screen>
  );
}
