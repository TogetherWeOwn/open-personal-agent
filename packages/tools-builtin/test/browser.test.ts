// SPDX-License-Identifier: Apache-2.0
// The `browser` tool against a fake recorded session (M4-09): no live Browser Rendering. The
// fake plays the adapter honestly — it consults the tool's guard before every navigation, as
// request interception does — so these tests pin the port contract the real adapter implements.
import { describe, expect, it } from "vitest";
import {
  BROWSER_MANIFEST,
  type BrowserGuard,
  type BrowserPage,
  type BrowserPorts,
  type BrowserSession,
  browserTool,
  builtinTools,
} from "../src/index";
import { fakePorts, signal } from "./helpers";

const html = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;

/** A five-page site on one host, plus one page elsewhere, as a recorded browse would meet them. */
const PAGES: Record<string, string> = {
  "https://archive.example/1": html("Page one", "<h1>One</h1><p>First page.</p>"),
  "https://archive.example/2": html("Page two", "<h1>Two</h1><p>Second page.</p>"),
  "https://archive.example/3": html("Page three", "<h1>Three</h1><p>Third page.</p>"),
  "https://archive.example/4": html("Page four", "<h1>Four</h1><p>Fourth page.</p>"),
  "https://archive.example/5": html("Page five", "<h1>Five</h1><p>Fifth page.</p>"),
  "https://archive.example/search?q=ferries": html("Results", "<p>3 sailings found.</p>"),
  "https://elsewhere.example/landing": html("Elsewhere", "<p>Another host entirely.</p>"),
  "https://archive.example/huge": html("Huge", `<p>${"x".repeat(80_000)}</p>`),
};

/** Link destinations per page, keyed by the selector or text a click would use. */
const LINKS: Record<string, Record<string, string>> = {
  "https://archive.example/1": {
    Next: "https://archive.example/2",
    Partner: "https://elsewhere.example/landing",
  },
  "https://archive.example/2": { Next: "https://archive.example/3" },
  "https://archive.example/3": { Next: "https://archive.example/4" },
  "https://archive.example/4": { Next: "https://archive.example/5" },
};

class FakeSession implements BrowserSession {
  current = "about:blank";
  closed = false;
  gone = false;
  constructor(private guard: BrowserGuard) {}

  private page(): BrowserPage {
    if (this.gone) {
      throw Object.assign(new Error("browser vanished"), { sessionGone: true });
    }
    return { url: this.current, html: PAGES[this.current] ?? html("Blank", "<p>nothing</p>") };
  }

  /** What interception does: ask the guard first; a refusal aborts and is noted. */
  private go(url: string) {
    if (!this.guard.mayNavigate(url)) {
      this.guard.noteBlocked(url);
      return;
    }
    this.current = url;
  }

  async navigate(url: string): Promise<BrowserPage> {
    this.go(url);
    return this.page();
  }

  async click(target: { selector?: string; text?: string }): Promise<BrowserPage> {
    const key = target.selector ?? target.text ?? "";
    const dest = LINKS[this.current]?.[key];
    if (!dest) throw new Error(`no element ${key}`);
    this.go(dest);
    return this.page();
  }

  async type(selector: string, text: string, submit: boolean): Promise<BrowserPage> {
    if (selector !== "#q") throw new Error(`no element ${selector}`);
    if (submit) this.go(`https://archive.example/search?q=${encodeURIComponent(text)}`);
    return this.page();
  }

  async read(): Promise<BrowserPage> {
    return this.page();
  }

  async screenshot(): Promise<Uint8Array> {
    this.page(); // a gone session screenshots nothing
    return new Uint8Array([137, 80, 78, 71]);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeBrowser(over: Partial<Omit<BrowserPorts, "ownHosts">> = {}) {
  const sessions: FakeSession[] = [];
  const metered: number[] = [];
  const shots: { png: Uint8Array; name: string }[] = [];
  let clock = 1_700_000_000_000;
  const ports: BrowserPorts = {
    ownHosts: ["opa.example.com"],
    openBrowserSession: async (guard) => {
      const session = new FakeSession(guard);
      sessions.push(session);
      return session;
    },
    saveScreenshot: async (png, name) => {
      shots.push({ png, name });
      return { artifactId: "shot-1", name, bytes: png.length };
    },
    meterBrowserSeconds: async (seconds) => {
      metered.push(seconds);
    },
    now: () => clock,
    ...over,
  };
  return {
    ports,
    sessions,
    metered,
    shots,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("browser (M4-09)", () => {
  it("runs a five-page browse with no computer anywhere in it (AC2)", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    const first = await tool.execute(
      { action: "open", url: "https://archive.example/1" },
      signal(),
    );
    expect(first.ok).toBe(true);
    expect(first.content).toContain("First page.");
    expect(first.context).toEqual({ kind: "web", label: "archive.example" });
    for (const expected of ["Second page.", "Third page.", "Fourth page.", "Fifth page."]) {
      const out = await tool.execute({ action: "click", text: "Next" }, signal());
      expect(out.ok).toBe(true);
      expect(out.content).toContain(expected);
      expect(out.context).toEqual({ kind: "web", label: "archive.example" });
    }
    expect(fake.sessions).toHaveLength(1);
    const done = await tool.execute({ action: "close" }, signal());
    expect(done.ok).toBe(true);
    expect(fake.sessions[0]?.closed).toBe(true);
    expect(fake.metered).toEqual([1]); // one session, metered once, minimum one second
  });

  it("types and submits on the approved host, and reads the result page", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    const out = await tool.execute(
      { action: "type", selector: "#q", text: "ferries", submit: true },
      signal(),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("3 sailings found.");
  });

  it("needs an open page before clicking or typing — nothing is typed on a first call", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    for (const input of [
      { action: "click", text: "Next" },
      { action: "type", selector: "#q", text: "x" },
      { action: "read" },
      { action: "screenshot" },
    ]) {
      const out = await tool.execute(input, signal());
      expect(out.ok).toBe(false);
      expect(out.content).toContain("Open a URL first");
    }
    expect(fake.sessions).toHaveLength(0);
  });

  it.each([
    "https://opa.example.com/api/me",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data/",
    "https://user:secret@archive.example/",
    "file:///etc/passwd",
    "not a url",
  ])("refuses to open %s before any session exists (AC1 URL policy)", async (url) => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    const out = await tool.execute({ action: "open", url }, signal());
    expect(out.ok).toBe(false);
    // The refusal speaks in the browser tool's name, never `web_fetch`'s.
    expect(out.content).not.toContain("web_fetch");
    expect(fake.sessions).toHaveLength(0);
  });

  it("stops page-driven navigation to a new host and names it, like a web_fetch redirect (AC1)", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    const out = await tool.execute({ action: "click", text: "Partner" }, signal());
    expect(out.ok).toBe(true);
    expect(out.content).toContain("URL: https://archive.example/1");
    expect(out.content).toContain("https://elsewhere.example/landing");
    expect(out.content).toContain("open that URL directly");
    // A fresh open of that host is its own call — and then it works.
    const direct = await tool.execute(
      { action: "open", url: "https://elsewhere.example/landing" },
      signal(),
    );
    expect(direct.ok).toBe(true);
    expect(direct.content).toContain("Another host entirely.");
    expect(direct.context).toEqual({ kind: "web", label: "elsewhere.example" });
  });

  it("refuses subresource requests to the deployment itself and private addresses", async () => {
    const fake = fakeBrowser();
    let guard: BrowserGuard | undefined;
    const tool = browserTool({
      ...fake.ports,
      openBrowserSession: async (g) => {
        guard = g;
        return new FakeSession(g);
      },
    });
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    expect(guard?.mayRequest("https://opa.example.com/api/me")).toBe(false);
    expect(guard?.mayRequest("http://169.254.169.254/")).toBe(false);
    expect(guard?.mayRequest("http://localhost:8787/")).toBe(false);
    expect(guard?.mayRequest("https://cdn.example/app.js")).toBe(true);
    expect(guard?.mayRequest("data:image/png;base64,AAAA")).toBe(true);
    expect(guard?.mayNavigate("https://archive.example/2")).toBe(true);
    expect(guard?.mayNavigate("https://archive.example:8443/2")).toBe(false);
    expect(guard?.mayNavigate("https://elsewhere.example/")).toBe(false);
  });

  it("caps extracted text exactly like web_fetch (AC2)", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    const out = await tool.execute(
      { action: "open", url: "https://archive.example/huge" },
      signal(),
    );
    expect(out.ok).toBe(true);
    expect(out.content).toContain("[Truncated at 50000 characters.]");
    expect(out.content.length).toBeLessThan(51_000);
  });

  it("saves a screenshot as an artifact the timeline can show (AC2 seam)", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    const out = await tool.execute({ action: "screenshot" }, signal());
    expect(out.ok).toBe(true);
    expect(out.artifact).toEqual({
      artifactId: "shot-1",
      name: expect.stringMatching(/^browser-archive\.example-.*\.png$/),
      type: "image/png",
      bytes: 4,
    });
    expect(fake.shots).toHaveLength(1);
  });

  it("closes an idle session, meters it once, and opens a genuinely fresh one next (AC3, AC4)", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    fake.advance(6 * 60_000);
    const stale = await tool.execute({ action: "read" }, signal());
    expect(stale.ok).toBe(false);
    expect(stale.content).toContain("five idle minutes");
    expect(fake.sessions[0]?.closed).toBe(true);
    expect(fake.metered).toEqual([360]);
    const fresh = await tool.execute(
      { action: "open", url: "https://archive.example/2" },
      signal(),
    );
    expect(fresh.ok).toBe(true);
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[1]).not.toBe(fake.sessions[0]);
  });

  it("ends plainly when the runtime recycles the browser, and meters that session once", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    const session = fake.sessions[0];
    if (session) session.gone = true;
    const out = await tool.execute({ action: "read" }, signal());
    expect(out.ok).toBe(false);
    expect(out.content).toContain("session ended");
    expect(fake.metered).toEqual([1]);
    const again = await tool.execute(
      { action: "open", url: "https://archive.example/1" },
      signal(),
    );
    expect(again.ok).toBe(true);
    expect(fake.sessions).toHaveLength(2);
  });

  it("dispose closes and meters a session the turn never closed, exactly once", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    fake.advance(42_000);
    // The turn answered without `close`; the loop's turn-end disposal is what runs this.
    await tool.dispose?.();
    expect(fake.sessions[0]?.closed).toBe(true);
    expect(fake.metered).toEqual([42]);
    await tool.dispose?.(); // idempotent: a second disposal meters nothing more
    expect(fake.metered).toEqual([42]);
  });

  it("binds approvals to the canonical host, from the URL or the live session", async () => {
    const fake = fakeBrowser();
    const tool = browserTool(fake.ports);
    expect(tool.target?.({ action: "open", url: "https://ARCHIVE.example./1" })).toBe(
      "archive.example",
    );
    expect(tool.target?.({ action: "click", text: "Next" })).toBeUndefined();
    await tool.execute({ action: "open", url: "https://archive.example/1" }, signal());
    expect(tool.target?.({ action: "click", text: "Next" })).toBe("archive.example");
  });

  it("manifests like the other tools, with no profile or cookie surface (AC1, AC4)", () => {
    expect(BROWSER_MANIFEST.name).toBe("browser");
    expect(BROWSER_MANIFEST.destinations).toEqual([
      { id: "web", kind: "third_party", dataEgress: true },
    ]);
    const schema = JSON.stringify(BROWSER_MANIFEST.inputSchema).toLowerCase();
    for (const banned of ["profile", "cookie", "storage", "authenticated"]) {
      expect(schema).not.toContain(banned);
    }
    // The caller is told typed text is entrusted to the page's site, which can send it on.
    expect(BROWSER_MANIFEST.description).toContain("never type secrets or personal data");
  });

  it("registers only when the host supplies browser ports (honest absence on Node)", () => {
    const without = builtinTools(fakePorts()).map((t) => t.manifest.name);
    expect(without).not.toContain("browser");
    const fake = fakeBrowser();
    const withBrowser = builtinTools(
      fakePorts({
        browser: {
          openBrowserSession: fake.ports.openBrowserSession,
          saveScreenshot: fake.ports.saveScreenshot,
          meterBrowserSeconds: fake.ports.meterBrowserSeconds,
        },
      }),
    ).map((t) => t.manifest.name);
    expect(withBrowser).toContain("browser");
  });
});
