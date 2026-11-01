// SPDX-License-Identifier: Apache-2.0
// The empty, loading and banner rows every m3-ux §3 state table uses.
import { type ReactNode, useEffect, useState } from "react";
import { Heading } from "react-aria-components";

/** One heading, one line and at most one action. */
export function EmptyState({
  title,
  level = 2,
  children,
  action,
}: {
  title: string;
  level?: number;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <Heading level={level} className="text-lg font-semibold">
        {title}
      </Heading>
      {children && <p className="max-w-[48ch] text-text-muted">{children}</p>}
      {action}
    </div>
  );
}

/** Grey blocks for content still loading. Nothing shows for the first 300 ms, so a fast load
 * doesn't flash. `label` is announced once, in place of the blocks. */
export function Skeleton({ label, lines = 3 }: { label: string; lines?: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <div role="status" className="flex flex-col gap-2 p-4">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are identical and never reorder
          key={i}
          aria-hidden="true"
          className="h-4 rounded bg-surface-sunken last:w-2/3 motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

const tones = {
  info: "border-status-info",
  warning: "border-status-warning",
  danger: "border-danger",
};

/** A full-width notice. `alert` interrupts a screen reader; use it only when something failed. */
export function Banner({
  tone = "info",
  alert = false,
  children,
}: {
  tone?: keyof typeof tones;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role={alert ? "alert" : "status"}
      className={`border-b border-l-4 border-b-border bg-surface-sunken px-4 py-2 text-sm ${tones[tone]}`}
    >
      {children}
    </div>
  );
}
