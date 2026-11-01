// SPDX-License-Identifier: Apache-2.0
// Settings › Memory (m3-ux §3.9; M3-15 AC5). "Learn from our chats" means the assistant may use
// `remember`. Off, it isn't offered the tool at all, so new notes come only from the Memory
// screen. Nothing is learned in the background in M3. Retention (M3-18 AC1) has its own card.
import { useEffect, useState } from "react";
import { Link, Switch } from "react-aria-components";
import { learnSetting } from "../memory/api";
import { Card, CardHeader, Skeleton } from "../ui";
import { RetentionSettings } from "./RetentionSettings";

const link = "font-medium text-accent underline underline-offset-2";

export function MemorySettings() {
  const [learn, setLearn] = useState<boolean | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    learnSetting().then(setLearn, () =>
      setError("I couldn't load this setting. Reload to try again."),
    );
  }, []);
  const change = async (on: boolean) => {
    const before = learn;
    setLearn(on);
    setError(null);
    setStatus("");
    try {
      setLearn(await learnSetting(on));
      setStatus("Saved");
    } catch {
      setLearn(before);
      setError("That didn't save. Try again.");
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <p>What your assistant remembers about you, and how it learns.</p>
      <Card labelledBy="learn">
        <CardHeader id="learn" level={2} title="Learning" />
        {learn === null && !error ? (
          <Skeleton label="Loading" lines={2} />
        ) : (
          <>
            <Switch
              isSelected={learn ?? false}
              isDisabled={learn === null}
              onChange={change}
              aria-describedby="learn-help"
              className="group flex min-h-11 items-center gap-3 font-medium"
            >
              <span className="flex h-6 w-10 items-center rounded-full border border-border-strong bg-surface-sunken p-0.5 group-data-selected:bg-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus-ring">
                <span className="size-4 rounded-full bg-text-muted group-data-selected:translate-x-4 group-data-selected:bg-accent-contrast" />
              </span>
              Learn from our chats
            </Switch>
            <p id="learn-help" className="text-sm text-text-muted">
              When this is on, I can save things you tell me in chat, like "remember I'm
              vegetarian". When it's off, I don't save anything new; you can still add notes
              yourself on the{" "}
              <Link href="/memory" className={link}>
                Memory
              </Link>{" "}
              screen. Things from web pages and files always wait for you to confirm them.
            </p>
          </>
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
      <RetentionSettings />
    </div>
  );
}
