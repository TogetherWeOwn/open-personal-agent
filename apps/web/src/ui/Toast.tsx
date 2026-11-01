// SPDX-License-Identifier: Apache-2.0
// The Undo toast (m3-ux §4.5). RAC's Toast is still `UNSTABLE_` in 1.22.1, so this is an inline
// row in its own landmark: it stays at least 10 s, the clock stops while the pointer is over it
// or focus is inside it. A live region inserted with its text already in it is often missed, so
// the screen announces the text through a region that is always there.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "./Button";

export const TOAST_MS = 10_000;

export function Toast({
  children,
  action,
  onAction,
  onClose,
  duration = TOAST_MS,
}: {
  children: ReactNode;
  /** The one action, for example "Undo". */
  action?: string;
  onAction?: () => void;
  /** Runs once when the time is up or the user dismisses it; not after `onAction`. */
  onClose: () => void;
  duration?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const left = useRef(Math.max(duration, TOAST_MS));
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(() => close.current(), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [hovered, focused]);
  return (
    <section
      aria-label="Notifications"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      className="sticky bottom-20 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border-strong bg-surface-raised p-3 shadow-lg sm:bottom-4"
    >
      <p className="min-w-0 flex-1">{children}</p>
      {action && onAction && (
        <Button variant="primary" onPress={onAction}>
          {action}
        </Button>
      )}
      <Button variant="quiet" onPress={() => close.current()}>
        Dismiss
      </Button>
    </section>
  );
}
