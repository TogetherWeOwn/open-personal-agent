// SPDX-License-Identifier: Apache-2.0
// Settings › Assistant's "Show work" card (M3-09 AC3, m3-ux §3.1): how much of a turn's
// timeline the thread shows. Saving is explicit, so a stray click never changes the thread.
import { useEffect, useState } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { SHOW_WORK_DEFAULT, SHOW_WORK_OPTIONS, type ShowWork } from "../chat/show-work";
import { Button, Card, CardHeader, Skeleton } from "../ui";
import { getShowWork, saveShowWork } from "./assistant-api";

const hint = "text-sm text-text-muted";

export function AssistantSettings() {
  const [saved, setSaved] = useState<ShowWork | null>(null);
  const [choice, setChoice] = useState<ShowWork>(SHOW_WORK_DEFAULT);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed" | "load_failed">(
    "idle",
  );

  useEffect(() => {
    getShowWork().then(
      (showWork) => {
        setSaved(showWork);
        setChoice(showWork);
      },
      () => setStatus("load_failed"),
    );
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saved === null || choice === saved) return;
    setStatus("saving");
    try {
      const showWork = await saveShowWork(choice);
      setSaved(showWork);
      setChoice(showWork);
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <Card labelledBy="assistant-show-work">
      <CardHeader id="assistant-show-work" level={2} title="Show work" />
      {status === "load_failed" ? (
        <p role="alert" className="text-sm text-danger">
          I couldn't load this setting. Reload to try again.
        </p>
      ) : saved === null ? (
        <Skeleton label="Loading" lines={3} />
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <RadioGroup
            value={choice}
            onChange={(v) => setChoice(v as ShowWork)}
            className="flex flex-col gap-2"
          >
            <Label className={hint}>How much of a run the thread shows.</Label>
            {SHOW_WORK_OPTIONS.map(({ value, label, detail }) => (
              <Radio
                key={value}
                value={value}
                className="group flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-1 hover:bg-surface-raised"
              >
                <span
                  aria-hidden="true"
                  className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border border-border-strong group-data-selected:border-accent"
                >
                  <span className="size-2 rounded-full group-data-selected:bg-accent" />
                </span>
                <span>
                  <span className="font-medium">{label}</span>
                  <span className={`block ${hint}`}>{detail}</span>
                </span>
              </Radio>
            ))}
          </RadioGroup>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              isDisabled={choice === saved || status === "saving"}
            >
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
        </form>
      )}
    </Card>
  );
}
