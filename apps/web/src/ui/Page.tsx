// SPDX-License-Identifier: Apache-2.0
// The frame of every routed screen (m3-ux §1.2): `document.title` names it, and after an in-app
// navigation focus moves to its `h1`, so a screen reader starts there.
import { type ReactNode, useEffect, useRef } from "react";
import { hasNavigated } from "../router";

export const APP_NAME = "Open Personal Agent";

export const pageTitle = (title: string) => `${title} · ${APP_NAME}`;

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
