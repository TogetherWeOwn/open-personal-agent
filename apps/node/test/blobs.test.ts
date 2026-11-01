// SPDX-License-Identifier: Apache-2.0
// The Node file store's listing (M3-20b): one prefix's keys page through the cursor, and a
// deleted key leaves the listing — so account deletion can prove the prefix empty. A cursor
// whose object vanishes concurrently still resumes at what follows it, and an unreadable
// directory throws instead of passing an empty page off as proven-empty.
import { mkdtempSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localBlobStore } from "../src/blobs";

const freshDir = () => mkdtempSync(join(tmpdir(), "opa-blobs-"));
const fresh = () => localBlobStore(freshDir());

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

  it("resumes past a cursor object deleted concurrently", async () => {
    const dir = freshDir();
    const files = localBlobStore(dir);
    await files.put("u/a/attachments/1", "one");
    await files.put("u/a/attachments/2", "two");
    await files.put("u/a/attachments/3", "three");

    const first = await files.list({ prefix: "u/a/", limit: 1 });
    if (!first.truncated) throw new Error("expected a second page");
    // The cursor names the next sidecar; remove it and its object mid-listing.
    const names = await readdir(dir);
    const sidecar = names.find((n) => n === first.cursor);
    if (sidecar === undefined) throw new Error("expected the cursor sidecar on disk");
    const target = sidecar.slice(0, -".key".length);
    await rm(join(dir, sidecar), { force: true });
    await rm(join(dir, target), { force: true });

    const second = await files.list({ prefix: "u/a/", limit: 10, cursor: first.cursor });
    // Two keys survive: the first page's and whatever follows the deleted cursor.
    expect(second.objects.map((o) => o.key)).toHaveLength(1);
    expect([...first.objects, ...second.objects].map((o) => o.key)).toHaveLength(2);
  });

  it("throws instead of reporting an unreadable directory as empty", async () => {
    const dir = freshDir();
    const files = localBlobStore(dir);
    await files.put("u/a/attachments/1", "one");
    await rm(dir, { recursive: true, force: true });
    await expect(files.list({ prefix: "u/a/" })).rejects.toThrow();
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
