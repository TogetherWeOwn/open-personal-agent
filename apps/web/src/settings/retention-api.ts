// SPDX-License-Identifier: Apache-2.0
// `GET/PUT /api/settings/retention` (M3-18 AC1). `null` keeps chats or tool outputs forever.

export interface RetentionSettings {
  messageDays: number | null;
  toolOutputDays: number | null;
  memoryInboxDays: number;
}

export type RetentionKey = keyof RetentionSettings;

export interface Retention extends RetentionSettings {
  defaults: RetentionSettings;
  bounds: Record<RetentionKey, { min: number; max: number }>;
}

async function call(init?: RequestInit): Promise<Retention> {
  const res = await fetch("/api/settings/retention", init);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as Retention;
}

export const getRetention = () => call();

export const saveRetention = (settings: RetentionSettings) =>
  call({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });

/** "14 days", "1 day"; "kept forever" for `null`. */
export const daysText = (days: number | null) =>
  days === null ? "kept forever" : `${days} ${days === 1 ? "day" : "days"}`;

/** A whole number of days within `bounds`, or `null`. */
export function parseDays(text: string, bounds: { min: number; max: number }): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days >= bounds.min && days <= bounds.max ? days : null;
}
