// SPDX-License-Identifier: Apache-2.0
import "./styles.css";
import { StrictMode, useEffect, useState } from "react";
import { RouterProvider } from "react-aria-components";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Setup } from "./auth/Setup";
import { SignIn } from "./auth/SignIn";
import { createMockTransport } from "./chat/mock-transport";
import { createSocketTransport } from "./chat/socket-transport";
import { Onboarding } from "./onboarding/Onboarding";
import { Usage } from "./usage/Usage";

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

// The e2e tests and a `vite dev` without a Worker build with `VITE_MOCK_CHAT=1`.
const transport =
  import.meta.env.VITE_MOCK_CHAT === "1" ? createMockTransport() : createSocketTransport();

type View = "setup" | "sign-in" | "onboarding" | "chat" | "usage";

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
  if (window.location.pathname === "/usage") return "usage";
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
  if (view === "chat" || view === "usage") return <Shell initialPath={window.location.pathname} />;
  return null;
}

/**
 * The signed-in app. Links move between the chat and `/usage` without a reload, and the chat stays
 * mounted (hidden) meanwhile, so its conversations and drafts survive a look at Usage.
 */
function Shell({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath);
  useEffect(() => {
    const back = () => setPath(window.location.pathname);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const navigate = (href: string) => {
    window.history.pushState(null, "", href);
    setPath(new URL(href, window.location.href).pathname);
  };
  const usage = path === "/usage";
  return (
    <RouterProvider navigate={navigate}>
      <div hidden={usage}>
        <App transport={transport} />
      </div>
      {usage && <Usage />}
    </RouterProvider>
  );
}

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
