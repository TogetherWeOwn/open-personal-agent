// SPDX-License-Identifier: Apache-2.0
// Thin styling over RAC's Disclosure, Menu and Tabs; the behaviour and ARIA are RAC's.
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Disclosure as AriaDisclosure,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  Tabs as AriaTabs,
  DisclosurePanel,
  type DisclosureProps,
  type MenuItemProps,
  MenuTrigger,
  Popover,
  Tab,
  TabList,
  TabPanel,
  type TabsProps,
} from "react-aria-components";
import { Button, type Variant } from "./Button";

/** The button text is the summary, so it is what a screen reader hears (m3-ux §4.2). No expand
 * animation, so reduced motion needs no case. */
export function Disclosure({
  summary,
  children,
  ...props
}: Omit<DisclosureProps, "children"> & { summary: ReactNode; children: ReactNode }) {
  return (
    <AriaDisclosure {...props} className="group flex flex-col">
      <AriaButton
        slot="trigger"
        className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left font-medium hover:bg-surface-raised"
      >
        <ChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 group-data-expanded:rotate-90"
        />
        {summary}
      </AriaButton>
      <DisclosurePanel className="px-2 pb-2">{children}</DisclosurePanel>
    </AriaDisclosure>
  );
}

/** A button that opens a list of actions. */
export function Menu({
  label,
  variant = "quiet",
  className = "",
  children,
}: {
  label: ReactNode;
  variant?: Variant;
  /** Layout for the trigger, as `Button` takes it. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <MenuTrigger>
      <Button variant={variant} className={className}>
        {label}
      </Button>
      <Popover className="min-w-48 rounded-xl border border-border bg-surface-raised p-1 shadow-lg">
        <AriaMenu className="outline-none">{children}</AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

export function MenuItem(props: MenuItemProps) {
  return (
    <AriaMenuItem
      {...props}
      className="flex min-h-11 cursor-default items-center rounded-lg px-3 outline-none data-focused:bg-surface-sunken"
    />
  );
}

/** Tabs from a list of `{ id, label, content }`. */
export function Tabs({
  label,
  tabs,
  ...props
}: Pick<TabsProps, "selectedKey" | "onSelectionChange"> & {
  label: string;
  tabs: { id: string; label: ReactNode; content: ReactNode }[];
}) {
  return (
    <AriaTabs {...props}>
      <TabList aria-label={label} className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <Tab
            key={t.id}
            id={t.id}
            className="-mb-px flex min-h-11 cursor-default items-center border-b-2 border-transparent px-3 font-medium text-text-muted outline-none data-selected:border-accent data-selected:text-text"
          >
            {t.label}
          </Tab>
        ))}
      </TabList>
      {tabs.map((t) => (
        <TabPanel key={t.id} id={t.id} className="py-3">
          {t.content}
        </TabPanel>
      ))}
    </AriaTabs>
  );
}
