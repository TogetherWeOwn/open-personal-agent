// SPDX-License-Identifier: Apache-2.0
// A titled list of things to finish with a meter of how many are done (m3-ux §5.2). A done item
// shows ✓ and "Done"; an open one offers its own action. Neither state uses a warning colour.
import type { ReactNode } from "react";
import { Heading, Label, Meter } from "react-aria-components";
import { Card } from "./Card";

export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
  /** What finishes it: a link or a button. Only shown while it isn't done. */
  action?: ReactNode;
}

export function Checklist({
  id,
  title,
  level = 2,
  items,
  menu,
  children,
}: {
  id: string;
  title: string;
  level?: number;
  items: readonly ChecklistItem[];
  /** Beside the title, for example a Hide menu. */
  menu?: ReactNode;
  /** Below the list. */
  children?: ReactNode;
}) {
  const done = items.filter((i) => i.done).length;
  return (
    <Card labelledBy={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading id={id} level={level} className="font-semibold">
          {title} · {done} of {items.length} done
        </Heading>
        {menu}
      </div>
      <Meter value={done} maxValue={items.length} className="flex flex-col gap-1">
        <Label className="sr-only">{title}</Label>
        <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full bg-accent" style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
      </Meter>
      <ul className="flex flex-col">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-t border-border py-1"
          >
            <span>
              {item.done && <span aria-hidden="true">✓ </span>}
              {item.label}
            </span>
            {item.done ? <span className="text-sm text-text-muted">Done</span> : item.action}
          </li>
        ))}
      </ul>
      {children}
    </Card>
  );
}
