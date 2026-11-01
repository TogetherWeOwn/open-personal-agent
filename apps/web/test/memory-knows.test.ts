// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Note } from "../src/memory/api";
import { knowsMarkdown } from "../src/memory/markdown";

const note = (over: Partial<Note>): Note => ({
  id: "n",
  kind: "fact",
  text: "Likes tea",
  trust: "user",
  op: "create",
  source: "memory_screen",
  sourceRef: null,
  sourceExcerpt: null,
  conversation: null,
  createdAt: Date.UTC(2026, 9, 2),
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

describe("knowsMarkdown", () => {
  it("lists instructions and notes with trust and source", () => {
    const md = knowsMarkdown([
      note({ kind: "instruction", text: "Answer in British English" }),
      note({ text: "Sam lives in Leeds", trust: "external", source: "web" }),
    ]);
    expect(md).toContain("## About you\n\n- Answer in British English _(you told me;");
    expect(md).toContain("- Sam lives in Leeds _(from a web page or file; From a web page;");
  });

  it("shows Markdown in a note as typed and says when a section is empty", () => {
    const md = knowsMarkdown([note({ text: "**bold** [x](https://evil.example)" })]);
    expect(md).toContain("\\*\\*bold\\*\\* \\[x\\]\\(https://evil\\.example\\)");
    expect(md).toContain("## About you\n\n_Nothing yet._");
  });
});
