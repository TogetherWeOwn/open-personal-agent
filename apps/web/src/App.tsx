// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "unavailable";

export function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    // `/api/health` answers 503 with a JSON body while setup is unfinished or a check fails.
    fetch("/api/health")
      .then((res) => res.json())
      .then((body: { status?: string }) => {
        // The Worker serves the Finish setup page there, with the commands to run.
        if (body.status === "setup_required") window.location.replace("/setup");
        else setHealth(body.status === "ok" ? "ok" : "unavailable");
      })
      .catch(() => setHealth("unavailable"));
  }, []);

  return (
    <main>
      <h1>Hello from Open Personal Agent</h1>
      <p>
        API health: <output>{health}</output>
      </p>
    </main>
  );
}
