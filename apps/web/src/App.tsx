// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

type Health = "checking" | "ok" | "unavailable";

export function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body: { status?: string }) => setHealth(body.status === "ok" ? "ok" : "unavailable"))
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
