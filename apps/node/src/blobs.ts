// SPDX-License-Identifier: Apache-2.0
// The `FILES` binding on Node: the subset of R2's API the app uses, over a local directory. Each
// object is one file named by the SHA-256 of its key, so no key can escape the directory. Bodies
// stream to and from disk, so an upload is never held whole in memory here either (M3-10 AC1).
// Listing (M3-20b) reads the sidecar each `put` leaves beside its object: the hash names no
// prefix, so the `.key` file beside it remembers the key the object was stored under.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type Body = ConstructorParameters<typeof Response>[0];

export function localBlobStore(dir: string): R2Bucket {
  mkdirSync(dir, { recursive: true });
  const pathOf = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"));
  const sidecarOf = (key: string) => `${pathOf(key)}.key`;

  async function etagOf(path: string) {
    const hash = createHash("md5");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async function head(key: string) {
    const info = await stat(pathOf(key)).catch(() => null);
    if (!info) return null;
    const etag = await etagOf(pathOf(key));
    return { key, size: info.size, etag, httpEtag: `"${etag}"`, uploaded: info.mtime };
  }

  const bucket = {
    head,
    async get(key: string) {
      const meta = await head(key);
      if (!meta) return null;
      const path = pathOf(key);
      return {
        ...meta,
        body: Readable.toWeb(createReadStream(path)) as ReadableStream,
        arrayBuffer: async () => {
          const bytes = await readFile(path);
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
        },
        text: async () => (await readFile(path)).toString("utf8"),
        json: async () => JSON.parse((await readFile(path)).toString("utf8")),
      };
    },
    async put(key: string, value: Body) {
      // Stream to a temp file, publish the sidecar, then the body — in that order. A reader
      // never sees half an object; the sidecar's content is the key, so republishing it is
      // idempotent and a sidecar failure leaves the old object (body and sidecar) in place
      // instead of deleting a body the rename already replaced. The sidecar itself publishes
      // through a temp file renamed over it: `writeFile` truncates before writing, so a
      // failure mid-write would otherwise leave the old body with an unreadable sidecar the
      // listing skips. The sidecar temp keeps no `.key` suffix, so `list` ignores one a
      // crash leaves behind; a crash between the two renames leaves a sidecar naming the
      // old body (listed as before).
      const temp = join(dir, `.tmp-${randomUUID()}`);
      const sidecarTemp = join(dir, `.tmp-${randomUUID()}`);
      try {
        if (value instanceof ReadableStream) {
          await pipeline(Readable.fromWeb(value as never), createWriteStream(temp));
        } else {
          await writeFile(temp, new Uint8Array(await new Response(value).arrayBuffer()));
        }
        await writeFile(sidecarTemp, key, "utf8");
        await rename(sidecarTemp, sidecarOf(key));
        await rename(temp, pathOf(key));
      } catch (err) {
        await rm(temp, { force: true });
        await rm(sidecarTemp, { force: true });
        throw err;
      }
      return head(key);
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        await rm(pathOf(key), { force: true });
        await rm(sidecarOf(key), { force: true });
      }
    },
    /**
     * One page of the keys a prefix names, in sidecar order: R2's listing over the sidecars.
     * Objects whose sidecar is missing (written before sidecars existed) are not listed —
     * that predates every prefix walk, so an upgraded deployment's pre-sidecar objects need
     * an operator directory wipe once no account owns them. A sidecar naming a missing body
     * (a crash between the sidecar write and the rename) is skipped by the stat check below,
     * and the next `put` rewrites the sidecar idempotently. `cursor` is the sidecar name
     * to resume after; resuming at the first name at or past it, so a cursor object deleted
     * concurrently ends the page early instead of dropping every later key. A directory read
     * failure throws — an empty page must never masquerade as a proven-empty prefix.
     */
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const names = (await readdir(dir)).sort();
      const objects: { key: string; size: number; uploaded: Date }[] = [];
      let resume = options?.cursor === undefined;
      let cursor: string | undefined;
      for (const name of names) {
        if (!name.endsWith(".key")) continue;
        if (!resume) {
          if (options?.cursor !== undefined && name >= options.cursor) resume = true;
          else continue;
        }
        const key = await readFile(join(dir, name), "utf8").catch(() => null);
        if (key === null || !key.startsWith(prefix)) continue;
        const info = await stat(pathOf(key)).catch(() => null);
        if (!info) continue;
        if (objects.length >= limit) {
          cursor = name;
          break;
        }
        objects.push({ key, size: info.size, uploaded: info.mtime });
      }
      return cursor === undefined
        ? { objects, truncated: false as const }
        : { objects, truncated: true as const, cursor };
    },
  };
  return bucket as unknown as R2Bucket;
}
