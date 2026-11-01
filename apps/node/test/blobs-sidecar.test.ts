// SPDX-License-Identifier: Apache-2.0
// The Node file store's atomic sidecar publish (M3-20b): the sidecar lands through a temp
// file renamed over it, so a publish failure keeps the previous sidecar — and the old body
// it names — instead of truncating the sidecar first (`writeFile` opens with truncation).
// The fault below fails the publish rename; without the temp indirection the old sidecar
// would already be truncated and the listing would skip the surviving body.
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ failSidecarPublish: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (async (oldPath: string, newPath: string) => {
      if (fault.failSidecarPublish && newPath.endsWith(".key")) {
        throw new Error("simulated sidecar publish failure");
      }
      return actual.rename(
        oldPath as Parameters<typeof actual.rename>[0],
        newPath as Parameters<typeof actual.rename>[1],
      );
    }) as typeof actual.rename,
  };
});

import { localBlobStore } from "../src/blobs";

const KEY = "u/a/attachments/1";
const sidecarOf = (dir: string) =>
  join(dir, `${createHash("sha256").update(KEY).digest("hex")}.key`);

describe("localBlobStore atomic sidecar publish", () => {
  it("a failed sidecar publish keeps the old sidecar, body and listing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opa-blobs-sidecar-"));
    const files = localBlobStore(dir);
    await files.put(KEY, "old");

    fault.failSidecarPublish = true;
    try {
      await expect(files.put(KEY, "new")).rejects.toThrow("simulated sidecar publish failure");
    } finally {
      fault.failSidecarPublish = false;
    }

    // Old sidecar bytes, old body, old listing — and no temp files left behind.
    expect(await readFile(sidecarOf(dir), "utf8")).toBe(KEY);
    expect(await (await files.get(KEY))?.text()).toBe("old");
    const page = await files.list({ prefix: "u/a/" });
    expect(page.objects.map((o) => o.key)).toEqual([KEY]);
    expect((await readdir(dir)).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });
});
