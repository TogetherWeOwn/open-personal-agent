// SPDX-License-Identifier: Apache-2.0
// The composer's context chip (M3-06 AC3, AC6; m3-ux §3.2): "{model} · {provider}", what it
// costs, and a menu to switch this conversation's model. The harness is not on the chip in M3 —
// there is one engine, named on Settings › Agent engine; it joins the chip in M5.
// `\uFE0E` keeps the ⚠ glyph as text, not colour emoji.
import {
  Button,
  Link,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import {
  describePick,
  type ModelSettings,
  per100Messages,
  type RolePick,
} from "../models/settings-api";

const chipClass =
  "flex min-h-11 items-center gap-2 rounded-full border border-border-strong px-4 text-sm font-medium data-pressed:bg-surface-sunken";
const itemClass =
  "cursor-pointer rounded-lg px-3 py-2 data-focused:bg-surface-sunken data-disabled:opacity-50";

interface Props {
  settings: ModelSettings;
  /** This conversation's own pick; null follows the Chat role. */
  pinned: RolePick | null;
  onSwitch: (pick: RolePick | null) => void;
}

export function ModelChip({ settings, pinned, onSwitch }: Props) {
  const effective = pinned ?? settings.roles.chat;
  if (!effective) {
    return (
      <Link
        href="/settings/models"
        aria-label="No model set up. Go to Settings, Models to set one up"
        className="flex min-h-11 items-center gap-2 self-start rounded-full border border-status-warning px-4 text-sm font-medium text-status-warning"
      >
        <span aria-hidden="true">{"\u26A0\uFE0E "}</span>No model set up
      </Link>
    );
  }
  const { modelName, providerName, row } = describePick(settings, effective);
  const price = row && row.model === effective.model ? per100Messages(row.price) : null;
  const chat = settings.roles.chat ? describePick(settings, settings.roles.chat) : null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <MenuTrigger>
        <Button
          className={chipClass}
          aria-label={`${modelName} · ${providerName}, model for this chat. Change model`}
        >
          {modelName} · {providerName} <span aria-hidden="true">▾</span>
        </Button>
        <Popover className="min-w-64 rounded-xl border border-border-strong bg-surface-raised p-1 shadow-lg">
          <Menu
            aria-label="Model for this chat"
            onAction={(key) => {
              if (key === "default") return onSwitch(null);
              const picked = settings.providers.find((p) => p.id === key);
              if (picked?.model) onSwitch({ provider: picked.id, model: picked.model });
            }}
          >
            {settings.providers.map((p) => {
              const current = effective.provider === p.id && effective.model === p.model;
              const hint = per100Messages(p.price);
              return (
                <MenuItem
                  key={p.id}
                  id={p.id}
                  textValue={`${p.modelName ?? p.model} · ${p.providerName}`}
                  aria-label={`${p.modelName ?? p.model} · ${p.providerName}${current ? ", in use in this chat" : ""}`}
                  className={`${itemClass} ${current ? "font-semibold" : ""}`}
                >
                  <span className="block">
                    {current && <span aria-hidden="true">✓ </span>}
                    {p.modelName ?? p.model} · {p.providerName}
                  </span>
                  {hint && (
                    <span className="block text-sm font-normal text-text-muted">{hint}</span>
                  )}
                </MenuItem>
              );
            })}
            {pinned && chat && (
              <>
                <Separator className="my-1 border-t border-border" />
                <MenuItem
                  id="default"
                  textValue={`Use my chat model: ${chat.modelName} · ${chat.providerName}`}
                  className={itemClass}
                >
                  Use my chat model ({chat.modelName} · {chat.providerName})
                </MenuItem>
              </>
            )}
            <Separator className="my-1 border-t border-border" />
            <MenuItem href="/settings/models" className={itemClass}>
              Manage models…
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      {price && <span className="text-sm text-text-muted">{price}</span>}
    </div>
  );
}
