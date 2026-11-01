// SPDX-License-Identifier: Apache-2.0
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isOwnFile, Markdown, safeHref } from "../src/chat/Markdown";
import { HOSTILE_REPLY } from "../src/chat/mock-transport";

const html = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(Markdown, { text, streaming }));

describe("Markdown (M3-10 AC3, R7 M3-7)", () => {
  it("renders hostile output with no remote source, script, handler or unsafe link", () => {
    const out = html(HOSTILE_REPLY);
    const tags = out.match(/<[^>]+>/g)?.join("\n") ?? ""; // escaped text in code blocks is fine
    expect(tags).not.toMatch(/<(img|script|svg|iframe|image|object|embed|style)\b/i);
    expect(tags).not.toMatch(/\s(on\w+|style|srcset|src)=/i);
    expect(tags).not.toMatch(/javascript:|data:/i);
    // The only hrefs are the http(s) links the text asked for, each without a referrer.
    const hrefs = [...out.matchAll(/<a href="([^"]*)"([^>]*)>/g)];
    expect(hrefs.map((m) => m[1])).toEqual([
      "https://docs.example/guide",
      "https://evil.example/pixel.png?q=secret",
      "https://evil.example/auto",
    ]);
    for (const [, , attrs] of hrefs) {
      expect(attrs).toContain('rel="noopener noreferrer"');
      expect(attrs).toContain('target="_blank"');
    }
  });

  it("turns a remote image into a link and keeps a file from this app as an image", () => {
    expect(html("![cat](https://evil.example/cat.png)")).toContain("Image: evil.example/cat.png");
    expect(html("![cat](/api/files/u1/cat.png)")).toContain('<img src="/api/files/u1/cat.png"');
    expect(html("![cat](relative/cat.png)")).toContain("Image: cat");
  });

  it("shows a link's host when the text hides it", () => {
    expect(html("[the docs](https://evil.example/x)")).toContain("(evil.example)");
    expect(html("<https://evil.example/x>")).not.toContain("(evil.example)");
    expect(html("[evil.example](https://evil.example/x)")).not.toContain("(evil.example)");
    expect(html("[evil.example.bank.test](https://evil.example/x)")).toContain("(evil.example)");
  });

  it("treats an unclosed fence as code while streaming, with no copy button yet", () => {
    const out = html("Try this:\n\n```\n<img src=https://evil.example/x onerror=alert(1)>", true);
    expect(out).toContain("<pre");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("Copy code");
    expect(html("```\nls\n```")).toContain("Copy code");
  });

  it("wraps tables in a labelled scroll region", () => {
    expect(html("| a |\n| - |\n| 1 |")).toContain('<section aria-label="Table" tabindex="0"');
  });

  it("starts headings at h2 and never skips a level", () => {
    const out = html("# One\n\n#### Two\n\n## Three");
    expect([...out.matchAll(/<(h\d)/g)].map((m) => m[1])).toEqual(["h2", "h3", "h3"]);
  });

  it("accepts only http(s) and mailto links, and only plain /api/files/ images", () => {
    expect(safeHref("https://a.example/")).toBe("https://a.example/");
    expect(safeHref("mailto:me@a.example")).toBe("mailto:me@a.example");
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,x",
      "/x",
      "//a.example",
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
    expect(isOwnFile("/api/files/u1/a.png")).toBe(true);
    for (const bad of [
      "/api/files/../x",
      "/api/files/%2e%2e/x",
      "//api/files/a",
      "/api/files/a?x",
      "/api/x",
    ]) {
      expect(isOwnFile(bad)).toBe(false);
    }
  });
});
