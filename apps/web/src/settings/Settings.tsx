// SPDX-License-Identifier: Apache-2.0
// Settings (m3-ux §3.9): one screen, a page per axis. M3-06b ships Models and the read-only
// Agent engine page; the other axes arrive with their own cards.
import { useEffect } from "react";
import { Heading, Link } from "react-aria-components";
import { pageTitle } from "../ui";
import { AgentEngine } from "./AgentEngine";
import { ModelsSettings } from "./ModelsSettings";

export type SettingsPage = "models" | "agent-engine";

const PAGES: { id: SettingsPage; label: string; href: string }[] = [
  { id: "models", label: "Models", href: "/settings/models" },
  { id: "agent-engine", label: "Agent engine", href: "/settings/agent-engine" },
];

const link = "font-medium text-accent underline underline-offset-2";
const navLink =
  "flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-surface-raised aria-[current=page]:bg-surface-raised aria-[current=page]:ring-1 aria-[current=page]:ring-border-strong";

export function Settings({ page }: { page: SettingsPage }) {
  // A routed screen names the page, like every other screen in the route table.
  useEffect(() => {
    document.title = pageTitle("Settings");
  }, []);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-8">
      <Link href="/" className={`${link} self-start`}>
        <span aria-hidden="true">← </span>Chats
      </Link>
      <Heading level={1} className="text-2xl font-semibold">
        Settings
      </Heading>
      <nav aria-label="Settings pages" className="flex flex-wrap gap-2">
        {PAGES.map(({ id, label, href }) => (
          <Link
            key={id}
            href={href}
            {...(id === page ? { "aria-current": "page" as const } : {})}
            className={navLink}
          >
            {label}
          </Link>
        ))}
      </nav>
      {page === "models" ? <ModelsSettings /> : <AgentEngine />}
    </main>
  );
}
