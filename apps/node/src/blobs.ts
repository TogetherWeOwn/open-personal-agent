// SPDX-License-Identifier: Apache-2.0
// The `FILES` binding on Node: the subset of R2's API the app uses, over a local directory. Each
// object is one file named by the SHA-256 of its key, so no key can escape the directory.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Body = ConstructorParameters<typeof Response>[0];

export function localBlobStore(dir: string): R2Bucket {
  mkdirSync(dir, { recursive: true });
  const pathOf = (key: string) => join(dir, createHash("sha256").update(key).digest("hex"));

  async function head(key: string) {
    const info = await stat(pathOf(key)).catch(() => null);
    if (!info) return null;
    const etag = createHash("md5")
      .update(await readFile(pathOf(key)))
      .digest("hex");
    return { key, size: info.size, etag, httpEtag: `"${etag}"`, uploaded: info.mtime };
  }

  const bucket = {
    head,
    async get(key: string) {
      const meta = await head(key);
      if (!meta) return null;
      const bytes = await readFile(pathOf(key));
      return {
        ...meta,
        body: new Response(bytes).body,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
        text: async () => bytes.toString("utf8"),
        json: async () => JSON.parse(bytes.toString("utf8")),
      };
    },
    async put(key: string, value: Body) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      // Write then rename, so a reader never sees half an object.
      const temp = join(dir, `.tmp-${randomUUID()}`);
      await writeFile(temp, bytes);
      await rename(temp, pathOf(key));
      return head(key);
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) await rm(pathOf(key), { force: true });
    },
  };
  return bucket as unknown as R2Bucket;
}
