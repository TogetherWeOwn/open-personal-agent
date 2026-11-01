// SPDX-License-Identifier: Apache-2.0
// Settings › Assistant (m3-ux §3.9, §3.12): what the assistant calls you and knows about you, the
// same answers onboarding's About you takes, and the setup checklist, which stays here even after
// the chat hides it, and Show work (M3-09). Saving the profile finishes a skipped About you.
import { type FormEvent, useEffect, useState } from "react";
import { Form, Input, Label, TextArea, TextField } from "react-aria-components";
import { type ModelSettings, settingsApi } from "../models/settings-api";
import { SetupChecklist } from "../onboarding/SetupChecklist";
import { Button, Card, CardHeader, Skeleton } from "../ui";
import { ShowWorkCard } from "./ShowWorkCard";

const field = "flex flex-col gap-1";
const input =
  "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 placeholder:text-text-muted";

export function AssistantSettings() {
  const [profile, setProfile] = useState<{ displayName: string; about: string } | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a save, so the checklist shows About you as Done.
  const [saves, setSaves] = useState(0);

  useEffect(() => {
    settingsApi<ModelSettings>("").then(
      ({ displayName, about }) => setProfile({ displayName, about }),
      () => setError("I couldn't load this page. Reload to try again."),
    );
  }, []);

  // Editing after a save makes its outcome stale: neither "Saved" nor its error describes the
  // text now in the fields, so both go as soon as either field changes.
  const edit = (next: { displayName: string; about: string }) => {
    setProfile(next);
    setStatus("");
    setError(null);
  };

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!profile) return;
    setBusy(true);
    setStatus("");
    setError(null);
    try {
      await settingsApi("/profile", "PUT", profile);
      setStatus("Saved");
      setSaves((n) => n + 1);
    } catch {
      setError("That didn't save. Check your name and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SetupChecklist place="settings" reload={saves} />
      <Card labelledBy="about-you">
        <CardHeader id="about-you" level={2} title="About you" />
        {profile === null && !error ? (
          <Skeleton label="Loading" lines={2} />
        ) : (
          profile && (
            <Form className="flex flex-col gap-4" onSubmit={save}>
              <TextField
                isRequired
                value={profile.displayName}
                onChange={(displayName) => edit({ ...profile, displayName })}
                className={field}
              >
                <Label>What should your assistant call you?</Label>
                <Input className={input} maxLength={80} />
              </TextField>
              <TextField
                value={profile.about}
                onChange={(about) => edit({ ...profile, about })}
                className={field}
              >
                <Label>Anything it should know about you? (optional)</Label>
                <TextArea className={input} rows={3} maxLength={2000} />
              </TextField>
              <Button type="submit" variant="primary" isDisabled={busy} className="self-start">
                Save
              </Button>
            </Form>
          )
        )}
        <p role="status" className="text-sm">
          {status}
        </p>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </Card>
      <ShowWorkCard />
    </div>
  );
}
