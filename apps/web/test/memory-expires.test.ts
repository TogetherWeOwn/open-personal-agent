// SPDX-License-Identifier: Apache-2.0
// The Waiting proposal's expiry label (`memory/api.ts` `expiresIn`, distinct from the
// approvals helper of the same name): both branches, the singular day, and the null and
// past fallbacks the baselines used to show by accident.
import { describe, expect, it } from "vitest";
import { expiresIn } from "../src/memory/api";

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 1, 11, 0);

describe("expiresIn", () => {
  it("says Expires today in the last 24 hours, for no expiry, and once past", () => {
    expect(expiresIn(now + 12 * 3_600_000, now)).toBe("Expires today");
    expect(expiresIn(now, now)).toBe("Expires today");
    expect(expiresIn(null, now)).toBe("Expires today");
    expect(expiresIn(now - DAY, now)).toBe("Expires today");
  });

  it("counts whole future days, singular then plural", () => {
    expect(expiresIn(now + DAY, now)).toBe("Expires in 1 day");
    expect(expiresIn(now + 9 * DAY, now)).toBe("Expires in 9 days");
    // A part-day past a whole number of days does not round up.
    expect(expiresIn(now + 9 * DAY + 12 * 3_600_000, now)).toBe("Expires in 9 days");
  });
});
