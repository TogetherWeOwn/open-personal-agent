// SPDX-License-Identifier: Apache-2.0
// What an installed app opens to with no network (m3-ux §3.13): the nav and one calm message,
// no Retry spinner. Coming back online reconnects on its own.
import { useEffect } from "react";
import { NavShell } from "./NavShell";
import { Page } from "./ui";

export function Offline({ onOnline }: { onOnline: () => void }) {
  useEffect(() => {
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [onOnline]);
  return (
    <NavShell>
      <Page title="You're offline">
        <p className="text-lg">
          Your assistant keeps working on tasks in the cloud. I'll reconnect when you're back
          online.
        </p>
      </Page>
    </NavShell>
  );
}
