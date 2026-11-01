// SPDX-License-Identifier: Apache-2.0
// The data export client (M3-20 AC1, m3-ux §3.11): sizes read plainly at each unit, a start
// while one runs adopts the running row the 409 carries, and other failures surface their
// error code — the screen's copy maps those codes, so the test pins the codes, not the words.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, listExports, startExport } from "../src/settings/export-api";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe("formatBytes", () => {
  it("reads plainly at each unit", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB");
  });
});

describe("listExports", () => {
  it("returns the row history", async () => {
    stubFetch(200, { exports: [{ id: "e1", status: "ready" }] });
    await expect(listExports()).resolves.toEqual([{ id: "e1", status: "ready" }]);
  });

  it("surfaces the error code", async () => {
    stubFetch(401, { error: "unauthenticated" });
    await expect(listExports()).rejects.toThrow("unauthenticated");
  });
});

describe("startExport", () => {
  it("returns the created row", async () => {
    stubFetch(201, { id: "e1", status: "running" });
    await expect(startExport()).resolves.toEqual({ id: "e1", status: "running" });
  });

  it("adopts the running export the 409 carries", async () => {
    const running = { id: "e1", status: "running" };
    stubFetch(409, { error: "already_running", export: running });
    await expect(startExport()).resolves.toEqual(running);
  });

  it("surfaces other failures by error code", async () => {
    stubFetch(503, { error: "workflow_unavailable" });
    await expect(startExport()).rejects.toThrow("workflow_unavailable");
    stubFetch(409, { error: "conflict" });
    await expect(startExport()).rejects.toThrow("conflict");
  });
});
