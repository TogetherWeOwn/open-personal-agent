// SPDX-License-Identifier: Apache-2.0
// The installable app (M3-24 AC2; m3-ux §3.13): the offline shell's service worker, the browser's
// install prompt, and a quiet "new version" check. Never a custom install nag, never an automatic
// reload.
import { useEffect, useState, useSyncExternalStore } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

/** Registers the offline shell, and keeps the install prompt for the account menu. */
export function startPwa() {
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    changed();
  });
}

/** Opened from the home screen, or as an installed desktop app. */
export const isInstalled = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

/** iOS has no install prompt; Settings › Deployment explains Add to Home Screen instead. */
export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** The browser's own install dialog, while it offers one and the app isn't installed. */
export function useInstall(): (() => void) | null {
  const prompt = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => deferred,
  );
  if (!prompt || isInstalled()) return null;
  return () => {
    // A prompt can be shown once; the browser fires a fresh event if it may ask again.
    deferred = null;
    changed();
    void prompt.prompt().catch(() => {});
  };
}

/** The page's own entry script, which a deploy renames. */
const entry = (html: string) => /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];

/**
 * True once the server's page names another entry script than this one: a deploy happened.
 * Checked when the tab comes back, which is when an update is worth saying.
 */
export function useUpdateReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
    const current = mine && new URL(mine.src).pathname;
    if (!current || ready) return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/", { cache: "no-store" })
        .then((res) => (res.ok ? res.text() : ""))
        .then((html) => {
          const theirs = entry(html);
          if (theirs && theirs !== current) setReady(true);
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [ready]);
  return ready;
}
