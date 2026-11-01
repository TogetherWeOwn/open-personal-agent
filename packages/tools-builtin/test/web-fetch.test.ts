// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  checkFetchUrl,
  htmlToText,
  isPrivateIpLiteral,
  WEB_FETCH_CAPS,
  webFetchTool,
} from "../src/index";
import { fakeFetch, page, redirect, signal } from "./helpers";

describe("URL policy (M3-08 AC1)", () => {
  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "https://user:secret@example.com/",
    "http://localhost:8787/admin",
    "http://api.localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.16.0.9/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(checkFetchUrl(raw, []).ok).toBe(false);
  });

  it.each(["https://example.com/a?b=c", "http://1.1.1.1/", "https://[2606:4700:4700::1111]/"])(
    "allows %s",
    (raw) => {
      expect(checkFetchUrl(raw, []).ok).toBe(true);
    },
  );

  it("blocks the deployment's own hostname, however it is written", () => {
    const own = ["opa.example.com"];
    for (const raw of [
      "https://opa.example.com/api/me",
      "https://OPA.EXAMPLE.COM/",
      "https://opa.example.com./",
    ]) {
      expect(checkFetchUrl(raw, own).ok, raw).toBe(false);
    }
    // Another tenant of the same parent domain is not this deployment.
    expect(checkFetchUrl("https://other.example.com/", own).ok).toBe(true);
  });

  it("matches the deployment's own hostname however the host's entry is written", () => {
    // The host's entry may carry capitals, a port or unicode; the request arrives punycoded.
    expect(checkFetchUrl("https://xn--mnchen-3ya.de/", ["münchen.de"]).ok).toBe(false);
    expect(checkFetchUrl("https://opa.example.com/", ["OPA.EXAMPLE.COM:8787"]).ok).toBe(false);
  });

  it("isPrivateIpLiteral leaves names and public addresses alone", () => {
    expect(isPrivateIpLiteral("example.com")).toBe(false);
    expect(isPrivateIpLiteral("172.32.0.1")).toBe(false);
    expect(isPrivateIpLiteral("172.31.255.255")).toBe(true);
    expect(isPrivateIpLiteral("[::gg]")).toBe(true); // unparseable literal fails closed
  });
});

describe("web_fetch", () => {
  it("reads a page as text, with the title, and marks it web content", async () => {
    const { fetch } = fakeFetch(() =>
      page(
        "<html><head><title>Ferries &amp; tides</title><style>p{}</style></head>" +
          "<body><script>steal()</script><h1>Sailings</h1><p>First boat at 06:30.</p></body></html>",
      ),
    );
    const out = await webFetchTool({ fetch, ownHosts: [] }).execute(
      { url: "https://ferries.example/timetable" },
      signal(),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("URL: https://ferries.example/timetable");
    expect(out.content).toContain("Title: Ferries & tides");
    expect(out.content).toContain("First boat at 06:30.");
    expect(out.content).not.toContain("steal()");
    expect(out.context).toEqual({ kind: "web", label: "ferries.example" });
  });

  it("re-checks every redirect: to a private address, a bad scheme or its own host", async () => {
    for (const location of [
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "https://opa.example.com/api/me",
    ]) {
      const { fetch, asked } = fakeFetch(() => redirect(location));
      const tool = webFetchTool({ fetch, ownHosts: ["opa.example.com"] });
      const out = await tool.execute({ url: "https://news.example/story" }, signal());
      expect(out.ok, location).toBe(false);
      expect(out.content, location).toContain("Redirect refused");
      expect(asked, location).toEqual(["https://news.example/story"]); // never fetched
    }
  });

  it("follows a relative redirect and stops after the cap", async () => {
    const ok = fakeFetch((url) =>
      url.endsWith("/old") ? redirect("/new") : page("<p>landed</p>"),
    );
    const out = await webFetchTool({ fetch: ok.fetch, ownHosts: [] }).execute(
      { url: "https://example.com/old" },
      signal(),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("landed");
    expect(ok.asked).toEqual(["https://example.com/old", "https://example.com/new"]);

    const loop = fakeFetch(() => redirect("/again"));
    const capped = webFetchTool(
      { fetch: loop.fetch, ownHosts: [] },
      { ...WEB_FETCH_CAPS, maxRedirects: 2 },
    );
    const refused = await capped.execute({ url: "https://example.com/again" }, signal());
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain("redirected more than 2 times");
    expect(loop.asked).toHaveLength(3);
  });

  it("reads only the allowlisted content types, and not a missing one", async () => {
    const pdf = fakeFetch(() => page("%PDF-1.7", "application/pdf"));
    const out = await webFetchTool({ fetch: pdf.fetch, ownHosts: [] }).execute(
      { url: "https://example.com/x.pdf" },
      signal(),
    );
    expect(out.ok).toBe(false);
    expect(out.content).toContain("application/pdf");

    const bare = fakeFetch(() => new Response(new Uint8Array([104, 105]), { status: 200 }));
    const missing = await webFetchTool({ fetch: bare.fetch, ownHosts: [] }).execute(
      { url: "https://example.com/x" },
      signal(),
    );
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("didn't say what type");

    const json = fakeFetch(() => page('{"a":1}', "application/json"));
    const read = await webFetchTool({ fetch: json.fetch, ownHosts: [] }).execute(
      { url: "https://example.com/x.json" },
      signal(),
    );
    expect(read.content).toContain('{"a":1}');
  });

  it("caps the body it reads and the text it shows", async () => {
    const caps = { ...WEB_FETCH_CAPS, maxBytes: 16, maxChars: 10 };
    const big = fakeFetch(() => page(`<p>${"x".repeat(100)}</p>`));
    const out = await webFetchTool({ fetch: big.fetch, ownHosts: [] }, caps).execute(
      { url: "https://example.com/big" },
      signal(),
    );
    expect(out.ok).toBe(false);
    expect(out.content).toContain("larger than 16 bytes");

    const long = fakeFetch(() => page("abcdefghijklmnop", "text/plain"));
    const shown = await webFetchTool(
      { fetch: long.fetch, ownHosts: [] },
      { ...caps, maxBytes: 1024 },
    ).execute({ url: "https://example.com/t" }, signal());
    expect(shown.content).toContain("abcdefghij");
    expect(shown.content).toContain("[Truncated at 10 characters.]");
    expect(shown.content).not.toContain("klmnop");
  });

  it("bounds the title inside the model text cap", async () => {
    const { fetch } = fakeFetch(() =>
      page(
        `<html><head><title>${"T".repeat(120_000)}</title></head><body><p>short body</p></body></html>`,
      ),
    );
    const out = await webFetchTool({ fetch, ownHosts: [] }).execute(
      { url: "https://example.com/long" },
      signal(),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("short body");
    expect(out.content.length).toBeLessThan(WEB_FETCH_CAPS.maxChars + 3000);
  });

  it("stops at a cross-host redirect so the new host gets its own approval", async () => {
    const { fetch, asked } = fakeFetch(() => redirect("https://other.example/landing"));
    const out = await webFetchTool({ fetch, ownHosts: [] }).execute(
      { url: "https://news.example/story" },
      signal(),
    );
    expect(out.ok).toBe(false);
    expect(out.content).toContain("https://other.example/landing");
    expect(out.content).toContain("another host");
    expect(asked).toEqual(["https://news.example/story"]); // the other host is never fetched
  });

  it("stops at a same-host redirect to another port so the new URL gets its own approval", async () => {
    const { fetch, asked } = fakeFetch(() => redirect("https://example.com:8443/admin"));
    const out = await webFetchTool({ fetch, ownHosts: [] }).execute(
      { url: "https://example.com/start" },
      signal(),
    );
    expect(out.ok).toBe(false);
    expect(out.content).toContain("another port");
    expect(asked).toEqual(["https://example.com/start"]); // the new port is never fetched
  });

  it("still follows a redirect that stays on the same host", async () => {
    const ok = fakeFetch((url) =>
      url === "http://example.com/old"
        ? redirect("https://example.com/new")
        : page("<p>landed</p>"),
    );
    const out = await webFetchTool({ fetch: ok.fetch, ownHosts: [] }).execute(
      { url: "http://example.com/old" },
      signal(),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("landed");
    expect(ok.asked).toEqual(["http://example.com/old", "https://example.com/new"]);
  });

  it("times out instead of waiting on a silent server", async () => {
    const hang = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const tool = webFetchTool(
      { fetch: hang.fetch, ownHosts: [] },
      { ...WEB_FETCH_CAPS, timeoutMs: 20 },
    );
    const out = await tool.execute({ url: "https://slow.example/" }, signal());
    expect(out.ok).toBe(false);
    expect(out.content).toContain("took longer");
  });

  it("reports HTTP failures and unreachable hosts without tainting", async () => {
    const gone = fakeFetch(() => page("nope", "text/plain", 404));
    const out = await webFetchTool({ fetch: gone.fetch, ownHosts: [] }).execute(
      { url: "https://example.com/gone" },
      signal(),
    );
    expect(out).toMatchObject({ ok: false, context: { kind: "system" } });
    expect(out.content).toContain("HTTP 404");
    expect(out.content).not.toContain("nope");

    const down = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const failed = await webFetchTool({ fetch: down.fetch, ownHosts: [] }).execute(
      { url: "https://down.example/" },
      signal(),
    );
    expect(failed.ok).toBe(false);
    expect(failed.context).toEqual({ kind: "system" });
  });

  it("names the host as its target", () => {
    const tool = webFetchTool({ fetch: fakeFetch(() => page("")).fetch, ownHosts: [] });
    expect(tool.target?.({ url: "https://sub.example.com:8443/a" })).toBe("sub.example.com");
    expect(tool.target?.({ url: "junk" })).toBeUndefined();
    // One spelling per host, so a destination grant can't be matched by a look-alike spelling.
    expect(tool.target?.({ url: "https://EXAMPLE.com./a" })).toBe("example.com");
    expect(tool.target?.({ url: "https://bücher.example/" })).toBe("xn--bcher-kva.example");
  });
});

describe("htmlToText", () => {
  it("drops hidden and active content and decodes entities", () => {
    const { title, text } = htmlToText(
      "<title>A &lt; B</title><div style='display:none'>hidden form</div>" +
        "<p>one&nbsp;two</p><svg><text>svg words</text></svg><p>&#72;i</p>",
    );
    expect(title).toBe("A < B");
    expect(text).toContain("one two");
    expect(text).toContain("Hi");
    expect(text).not.toContain("svg words");
  });

  it("finishes fast on hostile soup: unterminated opens, comments and bare brackets", () => {
    const soup = "<title".repeat(5000) + "<!--".repeat(5000) + "<".repeat(5000);
    const started = Date.now();
    const { text } = htmlToText(soup);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(text).toContain("<title");
  });

  it("finishes fast on a page of nothing but unterminated comments", () => {
    const soup = "<!--".repeat(262144); // 1 MiB, the maxBytes cap
    const started = Date.now();
    const { text } = htmlToText(soup);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain("-->");
  });

  it("finishes fast on thousands of malformed script closers", () => {
    const soup = `<script>${"</script'".repeat(40000)}>`;
    const started = Date.now();
    const { text } = htmlToText(soup);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).not.toContain("script");
  });

  it("keeps stripping tags after an unterminated comment", () => {
    const { text } = htmlToText("<p>Hello</p><!--unfinished<script>hidden()</script><p>World</p>");
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("script");
    expect(text).not.toContain("hidden()");
  });

  it("does not let a stray bracket plus apostrophe leak markup", () => {
    const { text } = htmlToText("<p>I <3 it's fine</p><script>evil()</script><div>rest</div>");
    expect(text).toContain("rest");
    expect(text).not.toContain("evil()");
    expect(text).not.toContain("<script>");
  });

  it("keeps readable content when a span never closes", () => {
    const { text } = htmlToText("<p>kept</p><script>var x = 1;");
    expect(text).toContain("kept");
    expect(text).toContain("var x = 1;");
  });

  it("drops only the first head span", () => {
    const { title, text } = htmlToText("<head><title>T</title></head><head>second</head>");
    expect(title).toBe("T");
    expect(text).not.toContain("T");
    expect(text).toContain("second");
  });
});
