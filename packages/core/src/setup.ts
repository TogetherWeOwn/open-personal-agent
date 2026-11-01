// SPDX-License-Identifier: Apache-2.0
// Onboarding's skippable steps (M3-24 AC1, A-O2), in step order. A skipped one stays on the setup
// checklist until the user finishes it somewhere; Claim and the model step can't be skipped.
export const SETUP_STEPS = ["about", "costs", "safety", "chat"] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/** The checklist as `GET /api/settings` reports it; `skipped: null` means nothing ever was. */
export interface SetupState {
  skipped: SetupStep[] | null;
  hidden: boolean;
}
