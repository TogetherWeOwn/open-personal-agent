// SPDX-License-Identifier: Apache-2.0
// The streaming ZIP writer for the data export (M3-20 AC1). Entries are stored, never
// compressed: no compression pass, no dependency, and entry bytes stream from R2 to the R2
// multipart upload in chunks, so the archive is never in Worker memory or a step output. Only
// the central directory (names, sizes, checksums) is held. Capped at 4 GiB per archive and
// 65,535 entries — no ZIP64: an export that large is a bug, and the writer throws rather than
// emit a corrupt file. Runtime-agnostic (ADR 0011 #4): `Uint8Array` and `TextEncoder` only.

/** R2's smallest multipart part, except the last: the writer flushes full parts this size. */
const PART_BYTES = 5 * 1024 * 1024;
/** The largest archive (and entry) this writer emits: 4 GiB minus one, the ZIP32 bound. */
const MAX_BYTES = 0xffffffff;
/** The most entries the end record can count: its two count fields are 16 bits each. */
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The running CRC-32 of `bytes`, continuing from `crc` (0 for a new entry). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0) as number;
}

/** One archive entry: its name in the ZIP, and its bytes. */
export interface ZipEntry {
  name: string;
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
}

/** The R2 multipart upload the archive streams into; the caller owns its lifecycle. */
export interface ZipUpload {
  uploadPart(partNumber: number, value: Uint8Array): Promise<{ etag: string }>;
  complete(parts: { partNumber: number; etag: string }[]): Promise<unknown>;
  abort(): Promise<unknown>;
}

/** Full 5 MiB parts out, the remainder held: R2 refuses uneven non-last parts. */
class PartBuffer {
  private chunks: Uint8Array[] = [];
  private held = 0;
  constructor(private readonly flush: (part: Uint8Array) => Promise<void>) {}
  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.held += bytes.length;
    while (this.held >= PART_BYTES) {
      const part = new Uint8Array(PART_BYTES);
      let at = 0;
      while (at < PART_BYTES) {
        const head = this.chunks[0];
        if (!head) break;
        const take = Math.min(head.length, PART_BYTES - at);
        part.set(head.subarray(0, take), at);
        at += take;
        if (take === head.length) this.chunks.shift();
        else this.chunks[0] = head.subarray(take);
      }
      this.held -= PART_BYTES;
      await this.flush(part);
    }
  }
  async finish(): Promise<void> {
    if (this.held === 0) return;
    const tail = new Uint8Array(this.held);
    let at = 0;
    for (const chunk of this.chunks) {
      tail.set(chunk, at);
      at += chunk.length;
    }
    this.chunks = [];
    this.held = 0;
    await this.flush(tail);
  }
}

const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
const u32 = (v: number) =>
  new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);

/** MS-DOS date and time, clamping the pre-1980 to the epoch the format starts at. */
function dosTime(now: number): { time: number; date: number } {
  const d = new Date(Math.max(now, Date.UTC(1980, 0, 1)));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

async function* bodies(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Writes `entries` to `upload` as one stored archive and completes it, in entry order. Returns
 * the archive's byte size and entry count. On any failure the upload is left uncompleted for
 * the caller to abort: a half-written ZIP must never complete. Throws past the ZIP32 bounds
 * (4 GiB, 65,535 entries) rather than emit an archive whose end record cannot count it.
 */
export async function writeZip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  upload: ZipUpload,
  now: number = Date.now(),
): Promise<{ bytes: number; entries: number }> {
  const parts: { partNumber: number; etag: string }[] = [];
  let partNumber = 0;
  const out = new PartBuffer(async (part) => {
    partNumber += 1;
    const { etag } = await upload.uploadPart(partNumber, part);
    parts.push({ partNumber, etag });
  });
  // The central directory is the only thing held whole: names and sizes, never entry bytes.
  const central: Uint8Array[] = [];
  let centralBytes = 0;
  let offset = 0;
  let count = 0;
  const { time, date } = dosTime(now);
  const encoder = new TextEncoder();

  const emit = async (bytes: Uint8Array) => {
    offset += bytes.length;
    if (offset > MAX_BYTES) throw new Error("export exceeds the 4 GiB archive bound");
    await out.write(bytes);
  };

  for await (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (name.length === 0 || name.length > 0xffff) throw new Error("unusable ZIP entry name");
    const headerOffset = offset;
    await emit(
      concat([
        u32(0x04034b50),
        u16(20), // version needed: file with a data descriptor
        u16(0x0800 | 0x0008), // UTF-8 names; sizes follow in a descriptor
        u16(0), // stored
        u16(time),
        u16(date),
        u32(0), // crc: in the descriptor
        u32(0), // compressed size: in the descriptor
        u32(0), // uncompressed size: in the descriptor
        u16(name.length),
        u16(0), // no extra field
        name,
      ]),
    );
    let crc = 0;
    let size = 0;
    for await (const chunk of bodies(entry.body)) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      await emit(chunk);
    }
    await emit(concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]));
    const record = concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0x0800 | 0x0008),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      u16(0), // no comment
      u16(0), // disk
      u16(0), // internal attributes
      u32(0), // external attributes
      u32(headerOffset),
      name,
    ]);
    central.push(record);
    centralBytes += record.length;
    count += 1;
  }
  if (count > MAX_ENTRIES) throw new Error("export exceeds the 65,535 entry bound");

  const directoryOffset = offset;
  await emit(concat(central));
  await emit(
    concat([
      u32(0x06054b50),
      u16(0),
      u16(0), // this disk, directory's disk
      u16(count),
      u16(count),
      u32(centralBytes),
      u32(directoryOffset),
      u16(0), // no comment
    ]),
  );
  await out.finish();
  await upload.complete(parts);
  return { bytes: offset, entries: count };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
