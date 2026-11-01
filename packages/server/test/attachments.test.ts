// SPDX-License-Identifier: Apache-2.0
// Server MIME sniffing (M3-10 AC1): the first bytes decide, never the client's claimed type.
import { describe, expect, it } from "vitest";
import {
  attachmentMaxBytes,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  sniffAttachment,
} from "../src/attachments";
import type { Env } from "../src/env";

const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = new Uint8Array([...bytes("RIFF"), 0x24, 0x00, 0x00, 0x00, ...bytes("WEBP")]);
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

describe("sniffAttachment", () => {
  it("reads image and PDF signatures, whatever the name says", () => {
    expect(sniffAttachment(PNG, "notes.txt")).toEqual({ mediaType: "image/png", kind: "image" });
    expect(sniffAttachment(JPEG, "photo")).toEqual({ mediaType: "image/jpeg", kind: "image" });
    expect(sniffAttachment(bytes("GIF89a...."), "a.md")).toEqual({
      mediaType: "image/gif",
      kind: "image",
    });
    expect(sniffAttachment(WEBP, "a.png")).toEqual({ mediaType: "image/webp", kind: "image" });
    expect(sniffAttachment(bytes("%PDF-1.7\n"), "a.txt")).toEqual({
      mediaType: "application/pdf",
      kind: "pdf",
    });
  });

  it("takes the listed text types when the bytes look like text", () => {
    expect(sniffAttachment(bytes("hello\n"), "a.txt")).toEqual({
      mediaType: "text/plain",
      kind: "text",
    });
    expect(sniffAttachment(bytes("# Title\n"), "a.MD")).toEqual({
      mediaType: "text/markdown",
      kind: "text",
    });
    expect(sniffAttachment(bytes("a,b\n1,2\n"), "a.csv")).toEqual({
      mediaType: "text/csv",
      kind: "text",
    });
    expect(sniffAttachment(bytes('  {"a":1}'), "a.json")).toEqual({
      mediaType: "application/json",
      kind: "text",
    });
    expect(sniffAttachment(bytes("[1,2]"), "a.json")).toEqual({
      mediaType: "application/json",
      kind: "text",
    });
  });

  it("refuses everything else, including a binary wearing a text name", () => {
    expect(sniffAttachment(MZ, "setup.exe")).toBeNull();
    expect(sniffAttachment(MZ, "setup.txt")).toBeNull();
    expect(sniffAttachment(bytes("hello"), "a.exe")).toBeNull();
    expect(sniffAttachment(bytes("not json"), "a.json")).toBeNull();
    expect(sniffAttachment(bytes("<svg onload=alert(1)>"), "a.svg")).toBeNull();
    expect(sniffAttachment(new Uint8Array([0x68, 0x00, 0x69]), "a.txt")).toBeNull();
    expect(sniffAttachment(new Uint8Array([0xc3, 0x28]), "a.txt")).toBeNull();
  });

  it("allows a UTF-8 character cut in two by the sniff window", () => {
    // "café" with the é's second byte beyond the window.
    expect(sniffAttachment(new Uint8Array([0x63, 0x61, 0x66, 0xc3]), "a.txt")).not.toBeNull();
  });
});

describe("attachmentMaxBytes", () => {
  const env = (value?: string) => ({ OPA_ATTACHMENT_MAX_BYTES: value }) as unknown as Env;
  it("defaults to 10 MB and takes a sane configured value", () => {
    expect(DEFAULT_ATTACHMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(attachmentMaxBytes(env())).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
    expect(attachmentMaxBytes(env("1024"))).toBe(1024);
    expect(attachmentMaxBytes(env("nope"))).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
    expect(attachmentMaxBytes(env("-5"))).toBe(DEFAULT_ATTACHMENT_MAX_BYTES);
    expect(attachmentMaxBytes(env(String(500 * 1024 * 1024)))).toBe(100 * 1024 * 1024);
  });
});
