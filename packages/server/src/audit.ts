// SPDX-License-Identifier: Apache-2.0
// What a settings change writes to the Activity log (M3-19 AC3): each changed field with its old
// and new value, as Settings › Spending already does. A field holding the user's own words, such
// as "about", is named but its text is never copied into the log.

/** `{ field: { from, to } }` for every field in `after` that differs from `before`; null if none. */
export function changes<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  private_: readonly (keyof T)[] = [],
): Record<string, { from: unknown; to: unknown } | "changed"> | null {
  const out: Record<string, { from: unknown; to: unknown } | "changed"> = {};
  for (const key of Object.keys(after) as (keyof T & string)[]) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (from === to) continue;
    out[key] = private_.includes(key) ? "changed" : { from, to };
  }
  return Object.keys(out).length ? out : null;
}
