// SPDX-License-Identifier: Apache-2.0
// What an installed app opens to with no network (m3-ux §3.13): the nav and one calm message,
// no Retry spinner. It keeps re-asking who's signed in while it's shown, on a backoff capped
// like the chat socket's, so a server that comes back while the browser stayed connected
// reconnects on its own too — that recovery fires no `online` event.
import { useEffect } from "react";
import { NavShell } from "./NavShell";
import { Page } from "./ui";

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export function Offline({ onRetry }: { onRetry: () => Promise<void> }) {
  useEffect(() => {
    let stopped = false;
    let delay = FIRST_RETRY_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      await onRetry();
      // A retry that got through changes the view and unmounts this screen; only a screen
      // that's still shown schedules the next one, so retries never outlive it.
      if (stopped) return;
      timer = setTimeout(attempt, delay);
      delay = Math.min(MAX_RETRY_MS, delay * 2);
    };
    timer = setTimeout(attempt, delay);
    delay = Math.min(MAX_RETRY_MS, delay * 2);
    const sooner = () => {
      if (document.visibilityState === "visible") void onRetry();
    };
    window.addEventListener("online", sooner);
    window.addEventListener("focus", sooner);
    document.addEventListener("visibilitychange", sooner);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("online", sooner);
      window.removeEventListener("focus", sooner);
      document.removeEventListener("visibilitychange", sooner);
    };
  }, [onRetry]);
  return (
    <NavShell>
      <Page title="You're offline">
        <p className="text-lg">
          Your assistant keeps working on tasks in the cloud. I'll keep trying to reconnect.
        </p>
      </Page>
    </NavShell>
  );
}
