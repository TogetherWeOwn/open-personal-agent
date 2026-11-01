// SPDX-License-Identifier: Apache-2.0
// The streaming ZIP writer for data exports (M3-20 AC1): the CRC-32 vectors, a parsed
// round-trip of stored entries (local headers, data descriptors, the central directory and the
// end record), chunked and stream bodies, and the 5 MiB part boundary against an in-memory
// multipart upload.
import { describe, expect, it } from "vitest";
import { crc32, writeZip, type ZipEntry, type ZipUpload } from "../src/export-zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An in-memory multipart upload: parts by number, concatenated in order. */
class MemoryUpload implements ZipUpload {
  parts: Uint8Array[] = [];
  completed: { partNumber: number; etag: string }[] | null = null;
  async uploadPart(partNumber: number, value: Uint8Array): Promise<{ etag: string }> {
    this.parts[partNumber - 1] = value;
    return { etag: `etag-${partNumber}` };
  }
  async complete(parts: { partNumber: number; etag: string }[]): Promise<unknown> {
    this.completed = parts;
    return null;
  }
  aborted = false;
  async abort(): Promise<unknown> {
    this.aborted = true;
    return null;
  }
  bytes(): Uint8Array {
    const total = this.parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** An entry whose body arrives in chunks of `cut` bytes, through an async iterable. */
function chunked(name: string, text: string, cut: number): ZipEntry {
  const bytes = encoder.encode(text);
  return {
    name,
    body: (async function* () {
      for (let at = 0; at < bytes.length; at += cut) yield bytes.subarray(at, at + cut);
      if (bytes.length === 0) return;
    })(),
  };
}

/** An entry whose body is a `ReadableStream`, the shape R2 hands the writer. */
function streamed(name: string, text: string): ZipEntry {
  const bytes = encoder.encode(text);
  return {
    name,
    body: new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(bytes);
        c.close();
      },
    }),
  };
}

/** Parses a stored-descriptor archive: checks every signature and CRC, returns the entries. */
function parseZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  // No comment, so the end record is exactly 22 bytes at the end.
  const eocd = bytes.length - 22;
  expect(u32(eocd)).toBe(0x06054b50);
  const count = u16(eocd + 10);
  const centralSize = u32(eocd + 12);
  const centralOffset = u32(eocd + 16);
  const entries: { name: string; data: Uint8Array }[] = [];
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    expect(u32(at)).toBe(0x02014b50);
    const crc = u32(at + 16);
    const size = u32(at + 24);
    expect(u32(at + 20)).toBe(size); // compressed == uncompressed: stored
    const nameLength = u16(at + 28);
    const headerOffset = u32(at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    expect(u32(headerOffset)).toBe(0x04034b50); // local header
    const dataAt = headerOffset + 30 + u16(headerOffset + 26) + u16(headerOffset + 28);
    const data = bytes.subarray(dataAt, dataAt + size);
    expect(u32(dataAt + size)).toBe(0x08074b50); // descriptor signature
    expect(u32(dataAt + size + 4)).toBe(crc);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data });
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }
  expect(at - centralOffset).toBe(centralSize);
  return entries;
}

describe("crc32", () => {
  it("matches the standard vectors, incrementally and whole", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    const bytes = encoder.encode("the export's bytes");
    // Continuing from a running CRC equals the one-shot CRC.
    expect(crc32(bytes.subarray(9), crc32(bytes.subarray(0, 9)))).toBe(crc32(bytes));
  });
});

describe("writeZip", () => {
  it("round-trips stored entries, byte for byte", async () => {
    const upload = new MemoryUpload();
    const result = await writeZip(
      [
        chunked("conversations.json", `[{"id":"ca"}]`, 1),
        chunked("empty.json", "", 7),
        streamed("unicode-☃.json", `{"snow":"☃☃"}`),
      ],
      upload,
      Date.UTC(2026, 4, 1),
    );
    expect(result.entries).toBe(3);
    expect(result.bytes).toBe(upload.bytes().length);
    expect(upload.completed).toEqual([{ partNumber: 1, etag: "etag-1" }]);
    const entries = parseZip(upload.bytes());
    expect(entries.map((e) => e.name)).toEqual([
      "conversations.json",
      "empty.json",
      "unicode-☃.json",
    ]);
    expect(decoder.decode(entries[0]?.data)).toBe(`[{"id":"ca"}]`);
    expect(entries[1]?.data.length).toBe(0);
    expect(decoder.decode(entries[2]?.data)).toBe(`{"snow":"☃☃"}`);
  });

  // Multi-megabyte bodies push CRC and part-cutting through real work; allow for it.
  it("cuts full 5 MiB parts and round-trips across the boundary", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 10);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const upload = new MemoryUpload();
    const result = await writeZip(
      [
        {
          name: "big.bin",
          body: (async function* () {
            yield big;
          })(),
        },
        chunked("small.json", `{"ok":true}`, 3),
      ],
      upload,
      Date.UTC(2026, 4, 1),
    );
    expect(result.entries).toBe(2);
    // Every part but the last is exactly one full part; the tail carries the rest.
    expect(upload.parts.length).toBeGreaterThan(1);
    for (const part of upload.parts.slice(0, -1)) expect(part.length).toBe(5 * 1024 * 1024);
    const entries = parseZip(upload.bytes());
    expect(entries.map((e) => e.name)).toEqual(["big.bin", "small.json"]);
    expect(entries[0]?.data).toEqual(big);
    expect(decoder.decode(entries[1]?.data)).toBe(`{"ok":true}`);
  }, 30_000);

  it("writes an empty archive as an end record alone", async () => {
    const upload = new MemoryUpload();
    const result = await writeZip([], upload, Date.UTC(2026, 4, 1));
    expect(result).toEqual({ bytes: 22, entries: 0 });
    expect(parseZip(upload.bytes())).toEqual([]);
  });

  it("refuses an unusable entry name", async () => {
    const upload = new MemoryUpload();
    await expect(writeZip([chunked("", "x", 1)], upload)).rejects.toThrow(/entry name/);
  });

  // 65,536 tiny entries stay in memory-cheap streaming; only the central directory grows.
  it("refuses past 65,535 entries rather than wrap the end record's counts", async () => {
    const upload = new MemoryUpload();
    const entries = (function* () {
      for (let i = 0; i < 65_536; i++) yield chunked(`f${i}.json`, "{}", 9);
    })();
    await expect(writeZip(entries, upload)).rejects.toThrow(/65,535/);
    // The archive never completed: the caller aborts it, as the export's finish does.
    expect(upload.completed).toBeNull();
  }, 30_000);
});
