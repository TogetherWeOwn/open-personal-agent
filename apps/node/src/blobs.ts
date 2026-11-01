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
      // Write then rename, so a reader never sees half an object; a failed stream leaves none.
      const temp = join(dir, `.tmp-${randomUUID()}`);
      try {
        if (value instanceof ReadableStream) {
          await pipeline(Readable.fromWeb(value as never), createWriteStream(temp));
        } else {
          await writeFile(temp, new Uint8Array(await new Response(value).arrayBuffer()));
        }
        await rename(temp, pathOf(key));
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
      // The sidecar is what `list` reads: an object without one would survive a prefix purge,
      // so a sidecar the store cannot write removes the object instead of stranding it.
      try {
        await writeFile(sidecarOf(key), key, "utf8");
      } catch (err) {
        await rm(pathOf(key), { force: true });
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
     * Objects whose sidecar is missing (written before sidecars existed, or crashed between
     * the rename and the sidecar write) are not listed — `put` refuses the second case, and
     * the first predates every prefix walk. `cursor` is the sidecar name to resume after.
     */
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      let names: string[];
      try {
        names = (await readdir(dir)).sort();
      } catch {
        return { objects: [], truncated: false as const };
      }
      const objects: { key: string; size: number; uploaded: Date }[] = [];
      let resume = options?.cursor === undefined;
      let cursor: string | undefined;
      for (const name of names) {
        if (!name.endsWith(".key")) continue;
        if (!resume) {
          if (name === options?.cursor) resume = true;
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
