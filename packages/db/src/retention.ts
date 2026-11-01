// SPDX-License-Identifier: Apache-2.0
// Retention (COST-10, M3-18): the user's settings, as the repository stores them and the
// settings route checks them.
export const DAY_MS = 86_400_000;

/** What the user sets; `null` keeps that data forever. */
export interface RetentionSettings {
  /** A chat with no new message for this many days is deleted. */
  messageDays: number | null;
  /** Tool outputs in finished tasks are removed after this many days. */
  toolOutputDays: number | null;
  /** Unconfirmed memory suggestions expire to rejected after this many days. */
  memoryInboxDays: number;
}

export const RETENTION_DEFAULTS: RetentionSettings = {
  messageDays: null,
  toolOutputDays: 30,
  memoryInboxDays: 14,
};

/** The accepted range of each setting, in days. */
export const RETENTION_BOUNDS = {
  messageDays: { min: 7, max: 3650 },
  toolOutputDays: { min: 1, max: 3650 },
  memoryInboxDays: { min: 1, max: 90 },
} as const;

/** The stored row: `0` is how the columns say "forever". */
export const toSettings = (row: {
  messageRetentionDays: number;
  toolOutputRetentionDays: number;
  memoryInboxDays: number;
}): RetentionSettings => ({
  messageDays: row.messageRetentionDays || null,
  toolOutputDays: row.toolOutputRetentionDays || null,
  memoryInboxDays: row.memoryInboxDays,
});
