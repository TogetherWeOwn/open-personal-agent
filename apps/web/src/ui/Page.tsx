// SPDX-License-Identifier: Apache-2.0
// The frame of every routed screen (m3-ux §1.2): `document.title` names it, and after an in-app
// navigation focus moves to its `h1`, so a screen reader starts there.
import { type ReactNode, useEffect, useRef } from "react";
import { hasNavigated } from "../router";

export const APP_NAME = "Open Personal Agent";

/** What waits in the Inbox: the tab title starts with "(N) " while it isn't 0 (m3-ux §1.2). */
let waiting = 0;
const prefix = () => (waiting ? `(${waiting}) ` : "");

export const pageTitle = (title: string) => `${prefix()}${title} · ${APP_NAME}`;

/** Updates the count, and the current title with it. */
export function setInboxCount(count: number) {
  if (count === waiting) return;
  const bare = document.title.replace(/^\(\d+\) /, "");
  waiting = count;
  document.title = prefix() + bare;
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = pageTitle(title);
    if (hasNavigated()) heading.current?.focus();
  }, [title]);
  return (
    <main className="flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-8">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
          {title}
        </h1>
        {children}
      </div>
    </main>
  );
}
