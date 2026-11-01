// SPDX-License-Identifier: Apache-2.0
// Settings › Agent engine (M3-06 AC6, M3-19 AC1): the one place the harness is named in M3.
// There is a single engine, so the page is read-only; it exists so the separation is visible.
// The engine joins the composer's context chip when a second one ships (M5).
import { Heading } from "react-aria-components";

export function AgentEngine() {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="agent-engine-heading">
      <Heading level={2} id="agent-engine-heading" className="text-xl font-semibold">
        Agent engine
      </Heading>
      <p>
        The engine does the work between your messages: reading, deciding what to do, and acting.
        The model only writes the words. For now there is one engine, <code>builtin-loop</code>.
        When more arrive, you&apos;ll choose between them here.
      </p>
      <div className="flex flex-col gap-2 rounded-xl border border-accent bg-surface-raised p-4 ring-2 ring-accent">
        <p className="font-semibold">
          Built-in engine (<code>builtin-loop</code>){" "}
          <span className="font-normal text-text-muted">(in use)</span>
        </p>
        <ul className="flex list-disc flex-col gap-1 pl-6">
          <li>Uses tools</li>
          <li>Asks before risky actions</li>
          <li>Keeps working if you close the tab</li>
        </ul>
      </div>
    </section>
  );
}
