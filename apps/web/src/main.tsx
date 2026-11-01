// SPDX-License-Identifier: Apache-2.0
import "./styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Setup } from "./auth/Setup";
import { SignIn } from "./auth/SignIn";
import { createMockTransport } from "./chat/mock-transport";
import { Onboarding } from "./onboarding/Onboarding";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The setup link carries the token in the fragment. Take it out of the address bar and the
// history entry before anything renders. The token is base64, so a literal `+` stays a `+`
// (URLSearchParams would read it as a space).
const setupToken = fragmentToken(window.location.hash);
if (window.location.hash) {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

function fragmentToken(hash: string): string {
  const raw = /(?:^#|&)token=([^&]*)/.exec(hash)?.[1] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Mocked until the Assistant DO transport (M2-13) lands.
const transport = createMockTransport();

type View = "setup" | "sign-in" | "onboarding" | "chat";

/** Who is asking decides the screen. Anything but a signed-in user is kept from the chat. */
async function route(): Promise<View | null> {
  const me = await fetch("/api/me").catch(() => null);
  const body = (await me?.json().catch(() => null)) as { error?: string } | null;
  if (me?.status === 403 && body?.error === "not_claimed") {
    // A real navigation, so the server shows its own page if the deployment isn't ready yet.
    window.location.replace("/setup");
    return null;
  }
  if (!me?.ok) return "sign-in";
  if (window.location.pathname === "/onboarding") return "onboarding";
  const settings = await fetch("/api/settings").catch(() => null);
  const { onboarded } = ((await settings?.json().catch(() => null)) ?? {}) as {
    onboarded?: boolean;
  };
  if (onboarded !== false) return "chat";
  window.history.replaceState(null, "", "/onboarding");
  return "onboarding";
}

function Root() {
  // The server opens `/setup` only while the deployment can be claimed or recovered.
  const [view, setView] = useState<View | null>(
    window.location.pathname === "/setup" ? "setup" : null,
  );
  useEffect(() => {
    if (!view) route().then(setView);
  }, [view]);
  if (view === "setup") return <Setup initialToken={setupToken} />;
  if (view === "sign-in") return <SignIn />;
  if (view === "onboarding") return <Onboarding />;
  if (view === "chat") return <App transport={transport} />;
  return null;
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
