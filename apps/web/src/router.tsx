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
window.addEventListener("popstate", () => moved());

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

/** Sends RAC `Link`s and `href` menu items through `navigate` instead of a page load. */
export function Router({ children }: { children: ReactNode }) {
  return <RouterProvider navigate={(href) => navigate(href)}>{children}</RouterProvider>;
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}
