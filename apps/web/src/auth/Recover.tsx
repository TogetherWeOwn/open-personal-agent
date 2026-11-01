// SPDX-License-Identifier: Apache-2.0
// Recovery with a code (M2-10b): one of the codes saved at the claim and a new passkey sign the
// owner back in. The server replaces every other passkey and code and ends every other session,
// so someone else holding one is out too. The new codes are shown once, as after the claim.
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useState } from "react";
import { Input, Label, TextField } from "react-aria-components";
import { Button } from "../ui";
import { RecoveryCodes } from "./Setup";
import { Alert, cancelled, type Failure, input, post, Screen } from "./ui";

interface Recovered {
  recoveryCodes: string[];
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

  if (done) {
    return (
      <RecoveryCodes
        codes={done.recoveryCodes}
        mode="recovery"
        notice={
          <p>
            You're back in with a new passkey.{" "}
            <strong>Your other passkeys and your old recovery codes no longer work</strong>, every
            other session was signed out, and anything waiting on your approval was cancelled.
          </p>
        }
      />
    );
  }
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
      <Button
        onPress={start}
        isDisabled={busy || !code.trim()}
        variant="primary"
        className="self-start"
      >
        {error ? "Try again" : "Create a new passkey"}
      </Button>
    </Screen>
  );
}
