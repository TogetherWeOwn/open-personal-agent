// SPDX-License-Identifier: Apache-2.0
// The five destinations (m3-ux §1.2): a sidebar from 1024 px, an icon rail from 640 px, and below
// that a tab bar with Chat, Inbox, Activity and You (Memory, Settings and the account).
import {
  Activity,
  Brain,
  CircleUser,
  Inbox,
  type LucideIcon,
  MessageSquare,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-aria-components";
import { post } from "./auth/ui";
import type { Destination } from "./routes";
import { isDark, setDark } from "./theme";
import { Menu, MenuItem } from "./ui";

const DESTINATIONS: [Destination, string, string, LucideIcon][] = [
  ["chat", "Chat", "/", MessageSquare],
  ["inbox", "Inbox", "/inbox", Inbox],
  ["activity", "Activity", "/activity", Activity],
  ["memory", "Memory", "/memory", Brain],
  ["settings", "Settings", "/settings", Settings],
];

const signOut = () =>
  post("/api/auth/logout")
    .catch(() => {})
    .then(() => window.location.assign("/"));

/** Theme and sign out; on phones Memory and Settings join them. */
function AccountItems() {
  const dark = isDark();
  return (
    <>
      <MenuItem onAction={() => setDark(!dark)}>
        {dark ? "Switch to light theme" : "Switch to dark theme"}
      </MenuItem>
      <MenuItem onAction={signOut}>Sign out</MenuItem>
    </>
  );
}

const item =
  "flex min-h-11 items-center gap-3 rounded-lg px-3 font-medium hover:bg-surface-raised aria-[current=page]:bg-surface-raised aria-[current=page]:text-accent";

export function NavShell({
  current,
  sidebar,
  hideTabs = false,
  fit = false,
  children,
}: {
  /** Fits the screen to the window, for the chat, which scrolls its own thread. Other screens
   * scroll the page, with the nav kept in place. */
  fit?: boolean;
  current?: Destination | undefined;
  /** Shown under the destinations from 1024 px: the chat's New chat and conversation list. */
  sidebar?: ReactNode;
  /** Hides the phone tab bar, so the keyboard doesn't squeeze the thread while typing. */
  hideTabs?: boolean;
  children: ReactNode;
}) {
  const here = (d: Destination) => (d === current ? "page" : false);
  return (
    <div className={`${fit ? "h-dvh" : "min-h-dvh"} flex flex-col sm:flex-row`}>
      <div className="top-0 hidden h-dvh w-16 shrink-0 flex-col gap-2 border-r border-border bg-surface-sunken p-2 sm:sticky sm:flex lg:w-72 lg:p-3">
        <nav aria-label="Main">
          <ul className="flex flex-col gap-1">
            {DESTINATIONS.map(([id, label, href, Icon]) => (
              <li key={id}>
                <Link href={href} aria-current={here(id)} className={item}>
                  <Icon aria-hidden="true" size={20} className="shrink-0" />
                  <span className="sm:max-lg:sr-only">{label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <aside
          aria-label="Conversations"
          className="hidden min-h-0 flex-1 flex-col border-t border-border pt-2 lg:flex"
        >
          {sidebar}
        </aside>
        <section aria-label="Account" className="mt-auto">
          <Menu
            label={
              <>
                <CircleUser aria-hidden="true" size={20} />
                <span className="sm:max-lg:sr-only">Account</span>
              </>
            }
          >
            <AccountItems />
          </Menu>
        </section>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      <nav
        aria-label="Main"
        className={`${hideTabs ? "hidden" : "grid"} sticky bottom-0 grid-cols-4 border-t border-border bg-surface-sunken sm:hidden`}
      >
        {DESTINATIONS.slice(0, 3).map(([id, label, href, Icon]) => (
          <Link
            key={id}
            href={href}
            aria-current={here(id)}
            className={`${item} flex-col gap-0.5 py-1 text-xs`}
          >
            <Icon aria-hidden="true" size={20} />
            {label}
          </Link>
        ))}
        <Menu
          variant="quiet"
          label={
            <span
              data-current={current === "memory" || current === "settings" || undefined}
              className="flex flex-col items-center gap-0.5 text-xs data-current:text-accent"
            >
              <CircleUser aria-hidden="true" size={20} />
              You
            </span>
          }
        >
          <MenuItem href="/memory">Memory</MenuItem>
          <MenuItem href="/settings">Settings</MenuItem>
          <AccountItems />
        </Menu>
      </nav>
    </div>
  );
}
