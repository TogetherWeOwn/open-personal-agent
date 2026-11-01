// SPDX-License-Identifier: Apache-2.0
// Settings › Privacy & security copy (M3-19 AC2, m3-ux §3.9): every grant scope has a
// plain-words label, and every compromise confirmation says waiting approvals expire. Nothing
// here may name a builder.
import { describe, expect, it } from "vitest";
import {
  grantScopeLabel,
  privacyError,
  REGENERATE_CODES_CONFIRM,
  removePasskeyConfirm,
  SIGN_OUT_EVERYWHERE_CONFIRM,
} from "../src/settings/privacy-copy";

describe("grantScopeLabel", () => {
  it("covers every scope in plain words", () => {
    expect(grantScopeLabel({ id: "g1", tool: "web_fetch", scope: "task", createdAt: 0 })).toBe(
      "This task only",
    );
    expect(grantScopeLabel({ id: "g2", tool: "web_fetch", scope: "hour", createdAt: 0 })).toBe(
      "For an hour",
    );
    expect(
      grantScopeLabel({
        id: "g3",
        tool: "email_send",
        scope: "destination",
        destination: "example.com",
        createdAt: 0,
      }),
    ).toBe("Always for example.com");
  });
});

describe("confirmations", () => {
  it("says waiting approvals expire on a compromise signal, and stay on a rotation", () => {
    for (const copy of [removePasskeyConfirm("My key"), SIGN_OUT_EVERYWHERE_CONFIRM]) {
      expect(copy).toMatch(/approval/i);
      expect(copy).toMatch(/expir/i);
    }
    expect(REGENERATE_CODES_CONFIRM).toMatch(/approval/i);
    expect(REGENERATE_CODES_CONFIRM).not.toMatch(/expir/i);
  });
});

describe("privacyError", () => {
  it("names the failure in plain words, never the server's code", () => {
    expect(privacyError(new Error("last_passkey"))).toMatch(/only passkey/);
    expect(privacyError(new Error("not_found"))).toMatch(/already removed/);
    const text = privacyError(new Error("something_new"));
    expect(text).toMatch(/didn’t work/);
    expect(text).not.toContain("something_new");
  });
});
