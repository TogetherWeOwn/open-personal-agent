// SPDX-License-Identifier: Apache-2.0
// The `FILES` binding on Node: the subset of R2's API the app uses, over a local directory. Each
// object is one file named by the SHA-256 of its key, so no key can escape the directory. Bodies
// stream to and from disk, so an upload is never held whole in memory here either (M3-10 AC1).
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type Body = ConstructorParameters<typeof Response>[0];

export function localBlobStore(dir: string): R2Bucket {
  mkdirSync(dir, { recursive: true });
  const pathOf = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"));

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
      return head(key);
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) await rm(pathOf(key), { force: true });
    },
  };
  return bucket as unknown as R2Bucket;
}
