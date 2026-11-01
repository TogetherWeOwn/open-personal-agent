// SPDX-License-Identifier: Apache-2.0
// What the claim, recovery-codes and sign-in screens share: the page frame, the POST helper and
// the error alert.
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-aria-components";

export const input =
  "min-h-11 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 font-mono";
const link = "text-accent underline underline-offset-2";

/** One screen. Focus moves to its heading when it appears, so a screen reader starts there. */
export function Screen({ title, children }: { title: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <main className="mx-auto flex max-w-[560px] flex-col gap-5 px-4 py-10">
      <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold outline-none">
        {title}
      </h1>
      {children}
    </main>
  );
}

/** POSTs JSON. Resolves to the body, or rejects with the server's error code. */
export async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "unknown");
  return json as T;
}

/** The browser's passkey prompt was dismissed, timed out or refused. */
export const cancelled = (e: unknown) =>
  (e as Error).name === "NotAllowedError" || (e as Error).name === "AbortError";

export interface Failure {
  text: string;
  link?: { href: string; label: string };
}

/** Inserted with its text, so screen readers announce it; a repeat is removed and re-added. */
export function Alert({ failure }: { failure: Failure | null }) {
  if (!failure) return null;
  return (
    <p role="alert" className="text-danger">
      {failure.text}
      {failure.link && (
        <>
          {" "}
          <Link href={failure.link.href} className={link}>
            {failure.link.label}
          </Link>
        </>
      )}
    </p>
  );
}
