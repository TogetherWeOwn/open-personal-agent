// SPDX-License-Identifier: Apache-2.0
// One action as an approval card shows it (M3-07 AC6; m3-ux §3.3): what you see is what you sign,
// so the arguments are the bound ones, in full, with invisible characters made visible. The
// receipt reuses it as the read-only copy behind Details.
import type { ApprovalItem } from "@opa/core";
import { TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button, Disclosure } from "../ui";
import {
  actionOf,
  costText,
  emptyText,
  INVISIBLE,
  looksLikeAnother,
  ruleText,
  taintText,
} from "./copy";
import type { Receipt } from "./store";

/** Text exactly as it would be sent, with invisible characters made visible. */
export function Visible({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INVISIBLE)) {
    const at = m.index ?? 0;
    parts.push(text.slice(last, at));
    const code = (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    parts.push(
      <span key={at} className="rounded bg-surface-sunken px-1 text-sm text-text-muted">
        ⟨U+{code}⟩
      </span>,
    );
    last = at + m[0].length;
  }
  parts.push(text.slice(last));
  return <span className="whitespace-pre-wrap break-words">{parts}</span>;
}

function Value({ value }: { value: unknown }) {
  if (typeof value === "string") return <Visible text={value} />;
  const none = emptyText(value);
  if (none) return <span className="text-text-muted italic">{none}</span>;
  if (Array.isArray(value)) {
    return (
      <ul className="flex flex-col">
        {value.map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the payload is fixed while it shows
          <li key={i}>
            <Value value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (value && typeof value === "object")
    return <Fields fields={value as Record<string, unknown>} />;
  return <Visible text={JSON.stringify(value)} />;
}

export const keyLabel = (key: string) => {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * An object's fields, each under its own label, so a nested recipient reads like a top one. Two
 * keys that read the same (`to` and `To`, `user_id` and `userId`) also show the literal key, so
 * the user can tell which one the tool reads.
 */
function Fields({
  fields,
  className = "",
}: {
  fields: Record<string, unknown>;
  className?: string;
}) {
  const entries = Object.entries(fields);
  const seen = new Map<string, number>();
  for (const [k] of entries) seen.set(keyLabel(k), (seen.get(keyLabel(k)) ?? 0) + 1);
  return (
    <dl className={`grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 ${className}`}>
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium text-text-muted">
            <Visible text={keyLabel(k)} />
            {(seen.get(keyLabel(k)) ?? 0) > 1 && (
              <span className="ml-1 font-mono font-normal text-sm">
                (<Visible text={k} />)
              </span>
            )}
          </dt>
          <dd className="min-w-0">
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Every argument in full. A long one starts at 6 lines with Show all: never cut silently. */
function Payload({ args }: { args: string }) {
  const [all, setAll] = useState(false);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {
    parsed = { details: args };
  }
  const entries = Object.entries(parsed);
  if (!entries.length) return null;
  const long = args.length > 400 || args.split("\\n").length > 6;
  return (
    <div className="flex flex-col gap-1">
      <Fields
        fields={parsed}
        className={`rounded-lg border border-border bg-surface p-3 text-sm ${long && !all ? "max-h-36 overflow-hidden" : ""}`}
      />
      {long && (
        <Button variant="quiet" className="self-start" onPress={() => setAll(!all)}>
          {all ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

/** **To:** with the host's hidden characters shown, and a warning when it imitates another. */
export function TargetLine({ target }: { target: string }) {
  return (
    <p>
      <span className="font-medium">To: </span>
      <span className="break-all">
        <Visible text={target} />
      </span>
      {looksLikeAnother(target) && (
        <span className="mt-1 flex items-center gap-1 text-sm text-status-warning">
          <TriangleAlert aria-hidden="true" size={14} />
          Looks like another address. Check it carefully.
        </span>
      )}
    </p>
  );
}

/** One action's anatomy (M3-07 AC6): target, full payload, rule, taint reason, cost, Details. */
export function ItemBody({ item }: { item: ApprovalItem }) {
  const taint = taintText(item);
  const cost = costText(item);
  return (
    <>
      {item.target && <TargetLine target={item.target} />}
      <Payload args={item.args} />
      <p>
        <span className="font-medium">Rule: </span>
        {ruleText(item)}
      </p>
      {taint && (
        <p>
          <span className="font-medium">Why I'm careful: </span>
          {taint}
        </p>
      )}
      {cost && <p>{cost}</p>}
      <Disclosure summary="Details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          <dt className="text-text-muted">Tool</dt>
          <dd className="font-mono">{item.tool}</dd>
          <dt className="text-text-muted">Rule</dt>
          <dd className="font-mono">{item.rule}</dd>
          <dt className="text-text-muted">Risk</dt>
          <dd className="font-mono">{item.risk}</dd>
        </dl>
      </Disclosure>
    </>
  );
}

/** A decided batch: one line with its scope and time; Details reopens a read-only copy. */
export function ApprovalReceipt({ receipt }: { receipt: Receipt }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border px-3 py-2 text-sm">
      <p>{receipt.text}</p>
      <Disclosure summary="Details">
        <div className="flex flex-col gap-3">
          {receipt.batch.items.map((item) => (
            <div key={item.approvalId} className="flex flex-col gap-2">
              <p className="font-medium">{actionOf(item.tool)}</p>
              <ItemBody item={item} />
            </div>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}
