// SPDX-License-Identifier: Apache-2.0
// Now / Suggested for a proposal that changes a note (m3-ux §3.7). Removed words are struck
// through and added ones underlined, each also marked "removed" or "added" for screen readers,
// so colour is never the only signal (§4.10).

export type Part = { text: string; change: "same" | "removed" | "added" };

/** A word diff by longest common subsequence; whitespace stays attached to the word before it. */
export function diffWords(before: string, after: string): { now: Part[]; suggested: Part[] } {
  const a = before.match(/\S+\s*/g) ?? [];
  const b = after.match(/\S+\s*/g) ?? [];
  const key = (w: string | undefined) => w?.trim();
  // lcs[i][j]: how many words a[i..] and b[j..] share in order.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  const at = (i: number, j: number) => lcs[i]?.[j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] ?? [];
      row[j] =
        key(a[i]) === key(b[j]) ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const now: Part[] = [];
  const suggested: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
      now.push({ text: a[i++] ?? "", change: "same" });
      suggested.push({ text: b[j++] ?? "", change: "same" });
    } else if (j < b.length && (i === a.length || at(i, j + 1) >= at(i + 1, j))) {
      suggested.push({ text: b[j++] ?? "", change: "added" });
    } else {
      now.push({ text: a[i++] ?? "", change: "removed" });
    }
  }
  return { now, suggested };
}

const words = (parts: Part[], change: Part["change"]) =>
  parts
    .filter((p) => p.change === change)
    .map((p) => p.text.trim())
    .join(" ");

function Line({ label, parts }: { label: string; parts: Part[] }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-text-muted">{label}</span>
      <p aria-hidden="true" className="break-words">
        {parts.map((p, i) =>
          p.change === "same" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
            <span key={i}>{p.text}</span>
          ) : (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts never reorder
              key={i}
              className={
                p.change === "removed"
                  ? "text-danger line-through"
                  : "text-status-success underline decoration-2 underline-offset-2"
              }
            >
              {p.text}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

export function MemoryDiff({ before, after }: { before: string; after: string }) {
  const { now, suggested } = diffWords(before, after);
  const removed = words(now, "removed");
  const added = words(suggested, "added");
  const summary = [removed && `removed: ${removed}`, added && `added: ${added}`]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <p className="sr-only">
        Now: {before}. Suggested: {after}. {summary}
      </p>
      <Line label="Now" parts={now} />
      <Line label="Suggested" parts={suggested} />
    </div>
  );
}
