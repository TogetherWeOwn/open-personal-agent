// SPDX-License-Identifier: Apache-2.0
// The route layer (m3-ux §5.5): the address bar is the state, so Back, Forward and a reload all
// land on the same screen. `routes.tsx` is the table; this only follows `location.pathname`.
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { RouterProvider } from "react-aria-components";

const listeners = new Set<() => void>();
let moves = 0;
const moved = (counts = true) => {
  if (counts) moves++;
  for (const listener of listeners) listener();
};
// Guarded so the pure route helpers stay importable outside the browser (unit tests).
if (typeof window !== "undefined") window.addEventListener("popstate", () => moved());

/** `replace` swaps the current entry, for a route that only forwards; it isn't a move. */
export function navigate(href: string, replace = false) {
  window.history[replace ? "replaceState" : "pushState"](null, "", href);
  moved(!replace);
}

/** False until the first in-app navigation, so the first screen doesn't steal focus. */
export const hasNavigated = () => moves > 0;

export function usePath() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => window.location.pathname,
  );
}

export interface Matched<R> {
  route: R;
  params: Record<string, string>;
}

/** The first route whose `path` matches; `:name` matches one segment. */
export function match<R extends { path: string }>(routes: R[], path: string): Matched<R> | null {
  const parts = path.replace(/\/+$/, "").split("/");
  for (const route of routes) {
    const want = route.path.replace(/\/+$/, "").split("/");
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = want.every((seg, i) => {
      const got = parts[i] ?? "";
      if (!seg.startsWith(":")) return seg === got;
      if (!got) return false;
      try {
        params[seg.slice(1)] = decodeURIComponent(got);
      } catch {
        return false;
      }
      return true;
    });
    if (ok) return { route, params };
  }
  return null;
}

/** What a `/c/:conversationId` address means for the open chat, once resolved. */
export type ChatAddressResolution =
  /** Open the named chat: it has loaded and isn't open yet. */
  | { action: "select"; id: string }
  /** The loaded list has no such chat, so the address can't open anything: fall back. */
  | { action: "redirect" }
  /** The list hasn't loaded yet: the address may still name a real chat. */
  | { action: "wait" }
  /** Already open: nothing to do. */
  | { action: "none" };

/**
 * Resolves a `/c/:conversationId` address against the loaded chats. The Tasks view links each
 * run to its conversation this way (M3-13 AC2); without it the address changes while the open
 * chat stays put. Each address is adopted once by the caller, so switching chats in place
 * (which leaves the address behind) never yanks the open chat back.
 */
export function resolveChatAddress(
  conversationId: string,
  conversations: readonly { id: string }[],
  activeId: string,
  loaded: boolean,
): ChatAddressResolution {
  if (conversationId === activeId) return { action: "none" };
  if (conversations.some((c) => c.id === conversationId))
    return { action: "select", id: conversationId };
  return loaded ? { action: "redirect" } : { action: "wait" };
}

/** Sends RAC `Link`s and `href` menu items through `navigate` instead of a page load. */
export function Router({ children }: { children: ReactNode }) {
  return <RouterProvider navigate={(href) => navigate(href)}>{children}</RouterProvider>;
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}
