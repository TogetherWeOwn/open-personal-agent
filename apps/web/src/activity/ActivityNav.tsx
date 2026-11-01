// SPDX-License-Identifier: Apache-2.0
// Activity's three screens (m3-ux §1.2): Tasks, Outputs and the log. The nav opens Tasks, so each
// screen links to the other two; links, not tabs, because each has its own address.
import { Link } from "react-aria-components";

const SCREENS = [
  ["tasks", "Tasks", "/activity/tasks"],
  ["outputs", "Outputs", "/activity/outputs"],
  ["log", "Activity log", "/activity/log"],
] as const;

export function ActivityNav({ current }: { current: (typeof SCREENS)[number][0] }) {
  return (
    <nav aria-label="Activity">
      <ul className="flex gap-1 border-b border-border">
        {SCREENS.map(([id, label, href]) => (
          <li key={id}>
            <Link
              href={href}
              {...(id === current ? { "aria-current": "page" as const } : {})}
              className="-mb-px flex min-h-11 items-center border-b-2 border-transparent px-3 font-medium text-text-muted hover:text-text aria-[current=page]:border-accent aria-[current=page]:text-text"
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
