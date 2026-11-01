// SPDX-License-Identifier: Apache-2.0
// The suggested prompts (M3-24 AC1, m3-ux §3.12): one each for tools, memory and files. A chip
// fills the composer and sends nothing, so the user sees the prompt and can change it first.
import { useEffect, useState } from "react";
import { Button } from "../ui";

export const PROMPTS = {
  tools: "Read https://… and give me the three main points.",
  memory: "Remember that I'm vegetarian.",
  files: "Make me a one-page checklist for a weekend trip.",
};

/** Whether `web_fetch` is on, so the tools prompt can work; false until it loads, or if it fails. */
function useWebFetch() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    fetch("/api/settings/tools")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { tools?: { name: string; override: string | null }[] } | null) => {
        const tool = body?.tools?.find((t) => t.name === "web_fetch");
        setOn(!!tool && tool.override !== "never");
      })
      .catch(() => {});
  }, []);
  return on;
}

export function SuggestedPrompts({
  onPick,
  isDisabled = false,
}: {
  onPick: (prompt: string) => void;
  isDisabled?: boolean;
}) {
  const webFetch = useWebFetch();
  const prompts = webFetch ? Object.values(PROMPTS) : [PROMPTS.memory, PROMPTS.files];
  return (
    <ul aria-label="Suggested prompts" className="flex flex-col gap-2">
      {prompts.map((prompt) => (
        <li key={prompt}>
          <Button
            className="h-auto py-2 text-left"
            isDisabled={isDisabled}
            onPress={() => onPick(prompt)}
          >
            {prompt}
          </Button>
        </li>
      ))}
    </ul>
  );
}
