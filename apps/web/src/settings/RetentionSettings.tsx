// SPDX-License-Identifier: Apache-2.0
// Settings › Memory's retention card (M3-18 AC1, m3-ux §3.9): how long chats, tool outputs and
// unconfirmed memory suggestions are kept, each with its default shown next to it. A daily sweep
// applies them; a chat with a task or an approval still waiting is never deleted.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Form, Input, Label, Switch, Text, TextField } from "react-aria-components";
import { Button, Card, CardHeader, Skeleton } from "../ui";
import {
  daysText,
  getRetention,
  parseDays,
  type Retention,
  type RetentionKey,
  type RetentionSettings as Settings,
  saveRetention,
} from "./retention-api";

const field = "flex flex-col gap-1";
const input =
  "min-h-11 w-28 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 tabular-nums";
const hint = "text-sm text-text-muted";

const FIELDS: {
  key: RetentionKey;
  /** The switch that turns a "kept forever" setting on; absent where there is no forever. */
  toggle?: string;
  label: string;
  about: string;
}[] = [
  {
    key: "messageDays",
    toggle: "Delete old chats",
    label: "Delete a chat after this many days without a new message",
    about: "Its messages and files go with it. A chat still waiting on a task or on you is kept.",
  },
  {
    key: "toolOutputDays",
    toggle: "Remove old tool outputs",
    label: "Remove tool outputs this many days after a task ends",
    about: "What tools returned, such as fetched pages. The task and its answer stay.",
  },
  {
    key: "memoryInboxDays",
    label: "Forget unconfirmed suggestions after (days)",
    about: "Suggestions waiting for you on the Memory screen. I never save one you didn't confirm.",
  },
];

const text = (days: number | null) => (days === null ? "" : String(days));

export function RetentionSettings() {
  const [saved, setSaved] = useState<Retention | null>(null);
  const [days, setDays] = useState<Record<RetentionKey, string> | null>(null);
  const [on, setOn] = useState<Record<RetentionKey, boolean> | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed" | "load_failed">(
    "idle",
  );

  const show = useCallback((r: Retention) => {
    setSaved(r);
    // A setting kept forever offers its default, if it has one, once switched on.
    const shown = (k: RetentionKey) => text(r[k] ?? r.defaults[k]);
    setDays({
      messageDays: shown("messageDays"),
      toolOutputDays: shown("toolOutputDays"),
      memoryInboxDays: shown("memoryInboxDays"),
    });
    setOn({
      messageDays: r.messageDays !== null,
      toolOutputDays: r.toolOutputDays !== null,
      memoryInboxDays: true,
    });
  }, []);

  useEffect(() => {
    getRetention().then(show, () => setStatus("load_failed"));
  }, [show]);

  const loaded = saved && days && on;
  const parsed = (key: RetentionKey) => (loaded ? parseDays(days[key], saved.bounds[key]) : null);
  const invalid = (key: RetentionKey) => !!on?.[key] && parsed(key) === null;
  const canSave = !!loaded && FIELDS.every(({ key }) => !invalid(key));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || !on) return;
    // Only what changed here: a field left out keeps the server's value, so this page, if
    // it's been open a while, can't undo a change made elsewhere to a field it didn't touch.
    const changes: Partial<Settings> = {};
    for (const { key } of FIELDS) {
      const value = on[key] ? parsed(key) : null;
      if (value !== saved?.[key]) Object.assign(changes, { [key]: value });
    }
    setStatus("saving");
    try {
      show(await saveRetention(changes));
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <Card labelledBy="retention">
      <CardHeader id="retention" level={2} title="How long I keep things" />
      {status === "load_failed" ? (
        <p role="alert" className="text-sm text-danger">
          I couldn't load these settings. Reload to try again.
        </p>
      ) : !loaded ? (
        <Skeleton label="Loading" lines={3} />
      ) : (
        <Form onSubmit={submit} className="flex flex-col gap-5">
          <p className={hint}>Once a day I delete what's past these limits.</p>
          {FIELDS.map(({ key, toggle, label, about }) => {
            const { min, max } = saved.bounds[key];
            const help = `${key}-help`;
            return (
              <div key={key} className="flex flex-col gap-2">
                {toggle && (
                  <Switch
                    isSelected={on[key]}
                    onChange={(v) => setOn({ ...on, [key]: v })}
                    aria-describedby={help}
                    className="group flex min-h-11 items-center gap-3 font-medium"
                  >
                    <span className="flex h-6 w-10 items-center rounded-full border border-border-strong bg-surface-sunken p-0.5 group-data-selected:bg-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus-ring">
                      <span className="size-4 rounded-full bg-text-muted group-data-selected:translate-x-4 group-data-selected:bg-accent-contrast" />
                    </span>
                    {toggle}
                  </Switch>
                )}
                {on[key] && (
                  <TextField
                    value={days[key]}
                    onChange={(v) => setDays({ ...days, [key]: v })}
                    isInvalid={invalid(key) && days[key] !== ""}
                    aria-describedby={help}
                    className={field}
                  >
                    <Label className="font-medium">{label}</Label>
                    <Input className={input} inputMode="numeric" />
                    {invalid(key) && days[key] !== "" && (
                      <span className="text-sm text-danger">
                        Enter a whole number from {min} to {max}.
                      </span>
                    )}
                  </TextField>
                )}
                <Text id={help} className={hint}>
                  {about} Default: {daysText(saved.defaults[key])}.
                </Text>
              </div>
            );
          })}
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" isDisabled={!canSave || status === "saving"}>
              Save
            </Button>
            <span role="status" className={hint}>
              {status === "saved" ? "Saved." : ""}
            </span>
          </div>
          {status === "failed" && (
            <p role="alert" className="text-sm text-danger">
              That didn't save. Try again.
            </p>
          )}
        </Form>
      )}
    </Card>
  );
}
