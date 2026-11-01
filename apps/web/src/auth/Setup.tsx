// SPDX-License-Identifier: Apache-2.0
// Claim (M2-09): the setup token and a new passkey make this browser's user the owner. With a
// rotated token the same screen recovers the owner's account. The server hands out the recovery
// codes once, in the final response, and this screen is the only place they are ever shown.
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser";
import { useState } from "react";
import { Button, Checkbox, Input, Label, TextField } from "react-aria-components";
import { Alert, cancelled, type Failure, input, post, primary, Screen, secondary } from "./ui";

type Mode = "claim" | "recovery";
const SIGN_IN = { href: "/", label: "Sign in" };
const SETUP = { href: "/setup", label: "See what to change" };

function failure(code: string): Failure {
  switch (code) {
    case "invalid_token":
      return { text: "That setup token doesn't match. Check you copied all of it." };
    case "already_claimed":
      return { text: "This assistant already has an owner.", link: SIGN_IN };
    case "setup_conflict":
      return { text: "Setup was finished in another tab or browser.", link: SIGN_IN };
    case "setup_required":
    case "setup_token_too_short":
    case "setup_token_weak":
      return { text: "The server needs a change before it can be claimed.", link: SETUP };
    default:
      return { text: "Something went wrong and no passkey was saved. Try again." };
  }
}

export function Setup({ initialToken }: { initialToken: string }) {
  const [token, setToken] = useState(initialToken);
  const [askToken, setAskToken] = useState(!initialToken);
  const [mode, setMode] = useState<Mode>("claim");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const create = async (retried = false): Promise<void> => {
    const { mode, options } = await post<{
      mode: Mode;
      options: PublicKeyCredentialCreationOptionsJSON;
    }>("/setup/options", { token });
    setMode(mode);
    let credential: unknown;
    try {
      credential = await startRegistration({ optionsJSON: options });
    } catch (e) {
      if (cancelled(e)) return setError({ text: "No passkey was created." });
      throw e;
    }
    try {
      setCodes(
        (await post<{ recoveryCodes: string[] }>("/setup", { token, credential })).recoveryCodes,
      );
    } catch (e) {
      // The challenge expired or its cookie was lost: one fresh ceremony, without asking.
      if ((e as Error).message === "no_challenge" && !retried) return create(true);
      throw e;
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await create();
    } catch (e) {
      const code = (e as Error).message;
      if (code === "invalid_token") setAskToken(true);
      setError(failure(code));
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} mode={mode} />;
  return (
    <Screen title={mode === "recovery" ? "Recover your account" : "Claim your assistant"}>
      <p>
        Your device will ask for your fingerprint, face or screen lock. That's how you'll sign in.
        There's no password.
      </p>
      {askToken && (
        <TextField
          type="password"
          value={token}
          onChange={setToken}
          className="flex flex-col gap-1"
        >
          <Label>Setup token</Label>
          <Input className={input} autoComplete="off" spellCheck={false} />
        </TextField>
      )}
      <Alert failure={error} />
      <Button
        onPress={start}
        isDisabled={busy || !token.trim()}
        className={`${primary} self-start`}
      >
        {error ? "Try again" : "Create your passkey"}
      </Button>
    </Screen>
  );
}

function RecoveryCodes({ codes, mode }: { codes: string[]; mode: Mode }) {
  const [saved, setSaved] = useState(false);
  const [status, setStatus] = useState("");
  const text = `${codes.join("\n")}\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: "recovery-codes.txt",
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Screen title="Save your recovery codes">
      <p>
        If you lose your passkey, a recovery code gets you back in. Each code works once.{" "}
        <strong>They won't be shown again.</strong>
      </p>
      <ol
        aria-label="Recovery codes"
        className="grid gap-1 rounded-lg bg-surface-sunken p-4 font-mono sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          className={secondary}
          onPress={() =>
            navigator.clipboard.writeText(text).then(
              () => setStatus("Copied all codes."),
              () => setStatus("Copying didn't work. Download them instead."),
            )
          }
        >
          Copy all
        </Button>
        <Button className={secondary} onPress={download}>
          Download .txt
        </Button>
        <p role="status" className="self-center text-sm text-text-muted">
          {status}
        </p>
      </div>
      <Checkbox
        isSelected={saved}
        onChange={setSaved}
        className="group flex min-h-11 items-center gap-3"
      >
        <span
          aria-hidden="true"
          className="flex size-5 items-center justify-center rounded border-2 border-border-strong group-data-selected:border-accent group-data-selected:bg-accent group-data-selected:text-accent-contrast group-data-focus-visible:outline-2 group-data-focus-visible:outline-offset-2 group-data-focus-visible:outline-accent"
        >
          {saved && "✓"}
        </span>
        I've saved these codes somewhere safe
      </Checkbox>
      <Button
        isDisabled={!saved}
        className={`${primary} self-start`}
        // A recovered owner has usually finished onboarding already; the app routes them.
        onPress={() => window.location.assign(mode === "claim" ? "/onboarding" : "/")}
      >
        Continue
      </Button>
    </Screen>
  );
}
