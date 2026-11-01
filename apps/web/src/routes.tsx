// SPDX-License-Identifier: Apache-2.0
// Every signed-in URL (m3-ux §1.2). A new screen replaces its placeholder here, and nothing else
// changes: `App` renders whatever the matching route names. A route without a `screen` is the chat,
// which stays mounted behind the others so drafts and streams survive.
import type { ComponentType, ReactNode } from "react";
import { Link } from "react-aria-components";
import { Memory } from "./memory/Memory";
import { Redirect } from "./router";
import { Settings, type SettingsPage as ShippedSettingsPage } from "./settings/Settings";
import { EmptyState, Page } from "./ui";
import { Usage } from "./usage/Usage";

export type Destination = "chat" | "inbox" | "activity" | "memory" | "settings";

export interface Route {
  path: string;
  /** The destination the nav marks as current. */
  nav?: Destination;
  screen?: ComponentType<{ params: Record<string, string> }>;
}

const link = "font-medium text-accent underline underline-offset-2";

/** A screen not built yet: its title and the empty state m3-ux gives it. */
const placeholder = (title: string, empty: string, body?: string, action?: ReactNode) => () => (
  <Page title={title}>
    <EmptyState title={empty} action={action}>
      {body}
    </EmptyState>
  </Page>
);

const go = (href: string, label: string) => (
  <Link href={href} className={link}>
    {label}
  </Link>
);

export const SETTINGS: {
  id: string;
  label: string;
  empty?: string;
  body?: string;
  /** The screen already exists: serve it instead of the placeholder. */
  shipped?: boolean;
}[] = [
  { id: "assistant", label: "Assistant" },
  { id: "models", label: "Models", shipped: true },
  { id: "agent-engine", label: "Agent engine", shipped: true },
  {
    id: "computer",
    label: "Computer",
    empty: "Not set up.",
    body: "Your assistant works without one; it just can't browse like a person or run code.",
  },
  { id: "apps", label: "Apps & tools" },
  { id: "memory", label: "Memory" },
  { id: "spending", label: "Spending", shipped: true },
  { id: "privacy", label: "Privacy & security" },
  { id: "deployment", label: "Deployment" },
];

function SettingsList() {
  return (
    <nav aria-label="Settings pages">
      <ul className="flex flex-col gap-1">
        {SETTINGS.map((s) => (
          <li key={s.id}>
            <Link
              href={`/settings/${s.id}`}
              className="flex min-h-11 items-center rounded-lg px-3 hover:bg-surface-raised"
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SettingsPage({ params }: { params: Record<string, string> }) {
  const page = SETTINGS.find((s) => s.id === params.page);
  if (!page) return <NotFound />;
  // Models and Agent engine already shipped with real screens; the table serves them instead of
  // their placeholders, so the rebase keeps what `main` already gives those addresses.
  if (page.shipped) return <Settings page={page.id as ShippedSettingsPage} />;
  return (
    <Page title={page.label}>
      {go("/settings", "All settings")}
      <EmptyState title={page.empty ?? "Nothing to change here yet."}>{page.body}</EmptyState>
    </Page>
  );
}

export function NotFound() {
  return (
    <Page title="This page doesn't exist">
      <p>The link may be old, or the address may have a typo. {go("/", "Go to Chat")}</p>
    </Page>
  );
}

// m3-ux §1.2 names this screen "Waiting for you", so the two Memory addresses don't look alike.
const waiting = placeholder(
  "Waiting for you",
  "I'll remember things you tell me, like your preferences and ongoing projects.",
  "You can always see and change them here.",
);

export const routes: Route[] = [
  { path: "/", nav: "chat" },
  { path: "/c/:conversationId", nav: "chat" },
  {
    path: "/inbox",
    nav: "inbox",
    screen: placeholder(
      "Inbox",
      "Nothing needs you right now.",
      undefined,
      go("/activity", "See Activity"),
    ),
  },
  { path: "/approvals/:approvalId", nav: "inbox", screen: () => <Redirect to="/inbox" /> },
  { path: "/activity", nav: "activity", screen: () => <Redirect to="/activity/tasks" /> },
  {
    path: "/activity/tasks",
    nav: "activity",
    screen: placeholder(
      "Tasks",
      "No tasks yet.",
      "When I work on something for you, it shows up here.",
    ),
  },
  {
    path: "/activity/tasks/:taskId",
    nav: "activity",
    screen: placeholder(
      "Task",
      "This task doesn't exist or was deleted.",
      undefined,
      go("/activity/tasks", "See all tasks"),
    ),
  },
  {
    path: "/activity/outputs",
    nav: "activity",
    screen: placeholder(
      "Outputs",
      "Files I make for you show up here, like summaries and reports.",
    ),
  },
  {
    path: "/activity/outputs/:outputId",
    nav: "activity",
    screen: placeholder(
      "Output",
      "This file doesn't exist or was deleted.",
      undefined,
      go("/activity/outputs", "All files"),
    ),
  },
  {
    path: "/activity/log",
    nav: "activity",
    screen: placeholder("Activity log", "Nothing has happened yet."),
  },
  { path: "/memory", nav: "memory", screen: Memory },
  { path: "/memory/waiting", nav: "memory", screen: waiting },
  {
    path: "/settings",
    nav: "settings",
    screen: () => (
      <Page title="Settings">
        <SettingsList />
      </Page>
    ),
  },
  { path: "/settings/:page", nav: "settings", screen: SettingsPage },
  // Settings › Spending. It keeps the M2 address, so old links and bookmarks still work.
  { path: "/usage", nav: "settings", screen: Usage },
];
