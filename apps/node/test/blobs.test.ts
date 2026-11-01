// SPDX-License-Identifier: Apache-2.0
// The Node file store's listing (M3-20b): one prefix's keys page through the cursor, and a
// deleted key leaves the listing — so account deletion can prove the prefix empty.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localBlobStore } from "../src/blobs";

const fresh = () => localBlobStore(mkdtempSync(join(tmpdir(), "opa-blobs-")));

describe("localBlobStore list", () => {
  it("lists one prefix's keys and pages with the cursor", async () => {
    const files = fresh();
    await files.put("u/a/attachments/1", "one");
    await files.put("u/a/task-outputs/2", "two");
    await files.put("u/b/attachments/3", "three");

    const first = await files.list({ prefix: "u/a/", limit: 1 });
    expect(first.objects.map((o) => o.key)).toHaveLength(1);
    expect(first.truncated).toBe(true);
    if (!first.truncated) throw new Error("expected a second page");

    const second = await files.list({ prefix: "u/a/", limit: 1, cursor: first.cursor });
    expect(second.truncated).toBe(false);
    expect(new Set([...first.objects, ...second.objects].map((o) => o.key))).toEqual(
      new Set(["u/a/attachments/1", "u/a/task-outputs/2"]),
    );
  });

  it("forgets a deleted key", async () => {
    const files = fresh();
    await files.put("u/a/attachments/1", "one");
    await files.put("u/a/task-outputs/2", "two");
    await files.delete("u/a/attachments/1");
    const page = await files.list({ prefix: "u/a/" });
    expect(page.objects.map((o) => o.key)).toEqual(["u/a/task-outputs/2"]);
    expect(page.truncated).toBe(false);
  });
});
