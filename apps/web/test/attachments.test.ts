// SPDX-License-Identifier: Apache-2.0
// The composer's attachment rules and m3-ux §3.2 copy: interpolated from the config, never
// hardcoded to one deployment's cap.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  formatBytes,
  isRetryable,
  kindOfName,
  pickProblem,
  tooLargeCopy,
  UploadFailure,
  unreadKinds,
  unsupportedCopy,
  uploadProblem,
  willRead,
} from "../src/chat/attachments";

describe("formatBytes", () => {
  it("reads plainly at each unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(3 * 1024 * 1024 + 512 * 1024)).toBe("3.5 MB");
  });
});

describe("the §3.2 copy", () => {
  it("interpolates the cap and the extension", () => {
    expect(tooLargeCopy(DEFAULT_CONFIG.maxBytes)).toBe("Too large (max 10 MB)");
    expect(unsupportedCopy("setup.exe")).toBe(
      "I can't read .exe files. I can read images, PDFs and text files.",
    );
    expect(unsupportedCopy("noextension")).toBe(
      "I can't read this file. I can read images, PDFs and text files.",
    );
  });
});

describe("pickProblem", () => {
  it("refuses empty, oversize and unlisted files before any upload", () => {
    expect(pickProblem({ name: "a.txt", size: 0 }, DEFAULT_CONFIG)).toBe("That file is empty.");
    expect(pickProblem({ name: "a.txt", size: DEFAULT_CONFIG.maxBytes + 1 }, DEFAULT_CONFIG)).toBe(
      "Too large (max 10 MB)",
    );
    expect(pickProblem({ name: "setup.exe", size: 10 }, DEFAULT_CONFIG)).toContain(".exe files");
    expect(pickProblem({ name: "cat.PNG", size: 10 }, DEFAULT_CONFIG)).toBeNull();
    expect(pickProblem({ name: "data.json", size: 10 }, DEFAULT_CONFIG)).toBeNull();
    expect(pickProblem({ name: "noext", size: 10 }, DEFAULT_CONFIG)).not.toBeNull();
  });

  it("takes the cap from the config, not the default", () => {
    const small = { ...DEFAULT_CONFIG, maxBytes: 1024 };
    expect(pickProblem({ name: "a.txt", size: 2048 }, small)).toBe("Too large (max 1 KB)");
  });
});

describe("uploadProblem", () => {
  it("speaks of a server refusal in the same words as a refused pick", () => {
    expect(uploadProblem(new UploadFailure("too_large", 16), "a.txt", DEFAULT_CONFIG)).toBe(
      "Too large (max 16 B)",
    );
    expect(uploadProblem(new UploadFailure("unsupported_type"), "a.exe", DEFAULT_CONFIG)).toBe(
      unsupportedCopy("a.exe"),
    );
    expect(uploadProblem(new UploadFailure("empty_file"), "a.txt", DEFAULT_CONFIG)).toBe(
      "That file is empty.",
    );
    expect(uploadProblem(new UploadFailure("failed"), "a.txt", DEFAULT_CONFIG)).toBe(
      "Upload failed.",
    );
    expect(isRetryable(new UploadFailure("failed"))).toBe(true);
    expect(isRetryable(new UploadFailure("too_large", 16))).toBe(false);
  });
});

describe("what the model reads (AC2)", () => {
  const textOnly = { imageInput: false, pdfInput: false };
  const seesImages = { imageInput: true, pdfInput: false };

  it("gives text to any model, and the rest only where the flags allow", () => {
    expect(willRead("text", null)).toBe(true);
    expect(willRead("image", null)).toBeNull();
    expect(willRead("image", textOnly)).toBe(false);
    expect(willRead("image", seesImages)).toBe(true);
    expect(willRead("pdf", seesImages)).toBe(false);
  });

  it("names each unread kind once, in order", () => {
    expect(unreadKinds(["image", "text", "pdf", "image"], textOnly)).toEqual(["image", "pdf"]);
    expect(unreadKinds(["image"], null)).toEqual([]);
    expect(unreadKinds(["text"], textOnly)).toEqual([]);
  });

  it("reads the claimed kind from the name, by the config's list", () => {
    expect(kindOfName("cat.WebP", DEFAULT_CONFIG)).toBe("image");
    expect(kindOfName("bill.pdf", DEFAULT_CONFIG)).toBe("pdf");
    expect(kindOfName("notes.md", DEFAULT_CONFIG)).toBe("text");
    expect(kindOfName("setup.exe", DEFAULT_CONFIG)).toBeNull();
    expect(kindOfName("noext", DEFAULT_CONFIG)).toBeNull();
  });
});
