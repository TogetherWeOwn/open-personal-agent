// SPDX-License-Identifier: Apache-2.0
// The setup checklist (M3-24 AC1, A-O2; m3-ux §3.12): onboarding's skipped steps, on the empty
// state of a new chat and on Settings › Assistant, so it never disappears for good. A step finished
// anywhere turns Done the next time the card loads. It's a convenience: a failed load shows nothing.
import { SETUP_STEPS, type SetupState, type SetupStep } from "@opa/core";
import { Ellipsis } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-aria-components";
import { type ModelSettings, settingsApi } from "../models/settings-api";
import { Button, buttonClass, Checklist, Menu, MenuItem, Sheet } from "../ui";
import { setPrefill } from "./prefill";
import { SafetyExplainer } from "./Safety";
import { SuggestedPrompts } from "./Suggestions";

const LABELS: Record<SetupStep, string> = {
  about: "About you",
  costs: "Costs and limits",
  safety: "How I ask before acting",
  chat: "Try a first chat",
};

const post = (body: unknown) => settingsApi<SetupState>("/setup", "POST", body);

export function SetupChecklist({
  place,
  onPrompt,
  reload = 0,
}: {
  /** The chat's empty state can hide it and say "All set." once; Settings › Assistant keeps it. */
  place: "chat" | "settings";
  /** Puts a suggested prompt in the chat's composer; without it, a pick opens the chat with it. */
  onPrompt?: (prompt: string) => void;
  /** Changes when the card should load again, as when the chat shows after another screen. */
  reload?: number;
}) {
  const id = useId();
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [safety, setSafety] = useState(false);
  const [suggest, setSuggest] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [hideFailed, setHideFailed] = useState(false);
  // Every open item finished while this card was on screen: it says "All set." once.
  const [allSet, setAllSet] = useState(false);
  const open = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loads again each time `reload` changes
  useEffect(() => {
    let current = true;
    settingsApi<ModelSettings>("").then(
      (loaded) => current && loaded.setup && setSetup(loaded.setup),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [reload]);

  const remaining = setup?.skipped?.length ?? 0;
  useEffect(() => {
    if (open.current > 0 && remaining === 0) setAllSet(true);
    open.current = remaining;
  }, [remaining]);

  const finish = async (step: SetupStep) => {
    const next = await post({ done: step }).catch(() => null);
    if (!next) return;
    setSetup(next);
    if (!next.skipped?.length) setAllSet(true);
    setAnnouncement(next.skipped?.length ? `${LABELS[step]}: done.` : "All set.");
  };

  if (!setup?.skipped) return null;
  const { skipped } = setup;
  if (place === "chat" && setup.hidden) return null;
  if (!skipped.length && place === "settings") return <p>Setup complete.</p>;
  if (!skipped.length && !allSet) return null;
  const link = (href: string, label: string) => (
    <Link href={href} className={buttonClass("quiet")}>
      {label}
    </Link>
  );
  const actions: Record<SetupStep, ReactNode> = {
    about: link("/settings/assistant", "Finish in Settings"),
    costs: link("/settings/spending", "Review limits"),
    safety: (
      <Button variant="quiet" onPress={() => setSafety(true)}>
        Show me
      </Button>
    ),
    // Offered in Settings too: a hidden card leaves the chat with no way to finish this step.
    chat: (
      <Button variant="quiet" onPress={() => setSuggest(true)}>
        Show suggestions
      </Button>
    ),
  };
  const pick = async (prompt: string) => {
    if (onPrompt) {
      onPrompt(prompt);
      await finish("chat");
      return;
    }
    // From Settings: the chat takes the prompt at load, unsent, as after onboarding.
    setPrefill(prompt);
    await finish("chat");
    window.location.assign("/");
  };
  const hide = () =>
    post({ hidden: true }).then(
      (next) => {
        setHideFailed(false);
        setSetup(next);
      },
      () => setHideFailed(true),
    );
  // Every step the checklist covers, in step order; the ones not skipped were done in onboarding.
  const items = SETUP_STEPS.map((step) => ({
    id: step,
    label: LABELS[step],
    done: !skipped.includes(step),
    action: actions[step],
  }));

  return (
    <>
      {skipped.length > 0 && (
        <Checklist
          id={`${id}-setup`}
          title="Finish setting up"
          level={place === "chat" ? 3 : 2}
          items={items}
          menu={
            place === "chat" && (
              <Menu
                label={
                  <>
                    <Ellipsis aria-hidden="true" size={20} />
                    <span className="sr-only">Setup checklist options</span>
                  </>
                }
              >
                <MenuItem onAction={() => void hide()}>Hide</MenuItem>
              </Menu>
            )
          }
        >
          {hideFailed && (
            <p role="alert" className="text-danger">
              I couldn't hide this. Try again.
            </p>
          )}
          {suggest && skipped.includes("chat") && (
            <SuggestedPrompts onPick={(prompt) => void pick(prompt)} />
          )}
        </Checklist>
      )}
      {/* In the same place in every state, so each change is announced; "All set." also shows. */}
      <p role="status" className={skipped.length ? "sr-only" : "text-text-muted"}>
        {skipped.length ? announcement : "All set."}
      </p>
      <Sheet title="How I ask before acting" isOpen={safety} onOpenChange={setSafety}>
        <SafetyExplainer />
        <Button
          variant="primary"
          className="self-start"
          onPress={() => {
            setSafety(false);
            void finish("safety");
          }}
        >
          Got it
        </Button>
      </Sheet>
    </>
  );
}
