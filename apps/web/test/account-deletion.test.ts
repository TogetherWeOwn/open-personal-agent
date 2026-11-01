// SPDX-License-Identifier: Apache-2.0
// The account deletion client (M3-20 AC2–3, m3-ux §3.11): the preview names the only owner
// before any passkey, the delete runs the passkey step-up and retries once, and other failures
// surface their error code — the screen's copy maps those codes, so the test pins the codes,
// not the words.
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteAccount, isDeleteDisabled, previewDeletion } from "../src/settings/account-api";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("previewDeletion", () => {
  it("names the only owner", async () => {
    stubFetch(200, { isOnlyOwner: true });
    await expect(previewDeletion()).resolves.toEqual({ isOnlyOwner: true });
  });

  it("surfaces the error code", async () => {
    stubFetch(401, { error: "unauthenticated" });
    await expect(previewDeletion()).rejects.toThrow("unauthenticated");
  });
});

describe("isDeleteDisabled", () => {
  it("stays disabled until the preview names the only owner", () => {
    // Loading and preview-failed both leave onlyOwner null: the only owner
    // must see the unclaimed warning before the passkey ceremony.
    expect(isDeleteDisabled(null)).toBe(true);
    expect(isDeleteDisabled(true)).toBe(false);
    expect(isDeleteDisabled(false)).toBe(false);
  });
});

describe("deleteAccount", () => {
  it("returns the deletion result", async () => {
    stubFetch(200, { deleted: true, unclaimed: true });
    await expect(deleteAccount()).resolves.toEqual({ deleted: true, unclaimed: true });
  });

  it("surfaces other failures by error code", async () => {
    stubFetch(503, { error: "delete_failed" });
    await expect(deleteAccount()).rejects.toThrow("delete_failed");
    stubFetch(404, { error: "not_found" });
    await expect(deleteAccount()).rejects.toThrow("not_found");
    stubFetch(403, { error: "step_up_required" });
    await expect(deleteAccount()).rejects.toThrow("step_up_required");
  });
});

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: async () => ({ id: "credential" }),
}));

describe("deleteAccount step-up", () => {
  it("runs the passkey step-up and retries the delete", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        calls.push(String(url));
        if (String(url).endsWith("/step-up/session/options"))
          return new Response(JSON.stringify({ options: {} }), { status: 200 });
        if (String(url).endsWith("/step-up/session"))
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        if (calls.filter((u) => u === "/api/account").length === 1)
          return new Response(JSON.stringify({ error: "step_up_required" }), { status: 403 });
        return new Response(JSON.stringify({ deleted: true, unclaimed: false }), { status: 200 });
      }),
    );
    await expect(deleteAccount()).resolves.toEqual({ deleted: true, unclaimed: false });
  });
});
