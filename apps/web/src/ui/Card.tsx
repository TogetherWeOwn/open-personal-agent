// SPDX-License-Identifier: Apache-2.0
// The frame for approval, limit, inbox, task and memory cards. `tone` picks the surface, so an
// approval never looks like a message or a tool step (m3-ux §5.1).
import type { ReactNode } from "react";
import { Heading } from "react-aria-components";

const tones = {
  plain: "border-border bg-surface-raised",
  tool: "border-border bg-tool-surface",
  approval: "border-approval-border bg-approval-surface",
};

/** A `section` named by its header's heading when `labelledBy` is that heading's id. */
export function Card({
  tone = "plain",
  labelledBy,
  className = "",
  children,
}: {
  tone?: keyof typeof tones;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`flex flex-col gap-3 rounded-xl border p-4 ${tones[tone]} ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  id,
  level = 3,
  title,
  children,
}: {
  id?: string;
  level?: number;
  title: ReactNode;
  /** Shown after the title, for example a status chip. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Heading id={id} level={level} className="font-semibold">
        {title}
      </Heading>
      {children}
    </div>
  );
}
