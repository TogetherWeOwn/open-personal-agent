// SPDX-License-Identifier: Apache-2.0
// The Browser Rendering adapter against a fake puppeteer page (M4-09): the interception
// decisions are the security surface — a refused main-frame navigation is aborted and reported
// to the tool, a refused request is aborted silently, everything else continues untouched.
// No live browser runs here; the fake plays puppeteer's side of the same calls.
import { describe, expect, it } from "vitest";
import { browserSessionOpener, type LaunchBrowser } from "../src/browser-session";

class FakeRequest {
  decision: "continue" | "abort" | null = null;
  constructor(
    readonly href: string,
    readonly navigation: boolean,
    readonly frameRef: unknown,
    readonly handled = false,
  ) {}
  url() {
    return this.href;
  }
  isNavigationRequest() {
    return this.navigation;
  }
  isInterceptResolutionHandled() {
    return this.handled;
  }
  frame() {
    return this.frameRef;
  }
  async continue() {
    this.decision = "continue";
  }
  async abort() {
    this.decision = "abort";
  }
}

class FakePage {
  readonly main = { frame: "main" };
  listener: ((request: FakeRequest) => void) | null = null;
  interception = false;
  currentUrl = "about:blank";
  html = "<html><body>page</body></html>";
  typed: [string, string][] = [];
  pressed: string[] = [];
  clicked: string[] = [];
  /** Call order across the page surface, for the navigation-waiter ordering test. */
  events: string[] = [];
  /** Link/button elements a text click searches, played as the page's document. */
  elements: { text: string; clicked: boolean }[] = [{ text: "Next", clicked: false }];
  closed = false;
  failContent: Error | null = null;
  keyboard = {
    press: async (key: string) => {
      this.pressed.push(key);
      this.events.push("press");
    },
  };
  mainFrame() {
    return this.main;
  }
  async setRequestInterception(value: boolean) {
    this.interception = value;
  }
  on(_event: "request", listener: (request: FakeRequest) => void) {
    this.listener = listener;
  }
  /** Drive one intercepted request through the adapter's listener. */
  fire(request: FakeRequest) {
    this.listener?.(request);
    return request;
  }
  async goto(url: string) {
    if (!this.interception) throw new Error("navigated before interception was on");
    this.currentUrl = url;
    return null;
  }
  async waitForNavigation() {
    this.events.push("wait");
    return null;
  }
  async content() {
    if (this.failContent) throw this.failContent;
    return this.html;
  }
  url() {
    return this.currentUrl;
  }
  async click(selector: string) {
    this.clicked.push(selector);
    this.events.push("click");
  }
  async type(selector: string, text: string) {
    this.typed.push([selector, text]);
  }
  /**
   * Plays puppeteer's contract honestly: a **function** is invoked in the page with its
   * argument; a string would be evaluated as source and never called — the adapter must
   * not send one. The fake document the function reads is this page's `elements`.
   */
  async evaluate(fn: unknown, arg: string) {
    this.events.push("evaluate");
    if (typeof fn !== "function") return false;
    const g = globalThis as unknown as { document?: unknown };
    const previous = g.document;
    g.document = {
      querySelectorAll: () =>
        this.elements.map((el) => ({
          textContent: el.text,
          click: () => {
            el.clicked = true;
          },
        })),
    };
    try {
      return (fn as (text: string) => boolean)(arg);
    } finally {
      g.document = previous;
    }
  }
  async screenshot() {
    return new Uint8Array([137, 80, 78, 71]);
  }
  async close() {
    this.closed = true;
  }
}

/** The fake context: the session page plus the `targetcreated` listener, exposed to tests. */
class FakeContext {
  targetListener: ((target: { page(): Promise<FakePage | null> }) => void) | null = null;
  constructor(
    private page: FakePage | null,
    private log: string[],
    private pageError: Error | null = null,
  ) {}
  async newPage() {
    if (this.pageError) throw this.pageError;
    return this.page as never;
  }
  on(_event: "targetcreated", listener: (target: { page(): Promise<FakePage | null> }) => void) {
    this.targetListener = listener;
  }
  /** A page the visited page spawned (`window.open`, `target=_blank`). */
  spawn(spawned: FakePage | null) {
    this.targetListener?.({ page: async () => spawned });
  }
  async close() {
    this.log.push("context");
  }
}

function fakeLaunch(
  page: FakePage,
  log: string[] = [],
  contexts: FakeContext[] = [],
): LaunchBrowser {
  return async () => ({
    createBrowserContext: async () => {
      const context = new FakeContext(page, log);
      contexts.push(context);
      return context as never;
    },
    close: async () => {
      log.push("browser");
    },
  });
}

const guard = (blocked: string[]) => ({
  mayNavigate: (url: string) => url.startsWith("https://approved.example/"),
  mayRequest: (url: string) => !url.includes("private.example"),
  noteBlocked: (url: string) => blocked.push(url),
});

const signal = new AbortController().signal;

describe("browser session adapter (M4-09)", () => {
  it("gates requests through the tool's guard: nav vs subresource, blocked navs named", async () => {
    const page = new FakePage();
    const blocked: string[] = [];
    const session = await browserSessionOpener({}, fakeLaunch(page))(guard(blocked));

    const allowedNav = page.fire(new FakeRequest("https://approved.example/a", true, page.main));
    const refusedNav = page.fire(new FakeRequest("https://other.example/b", true, page.main));
    const refusedAsset = page.fire(
      new FakeRequest("https://private.example/x.png", false, page.main),
    );
    const asset = page.fire(new FakeRequest("https://cdn.example/x.js", false, page.main));
    // A subframe navigation is a request, not a main-frame navigation.
    const subframe = page.fire(new FakeRequest("https://other.example/frame", true, {}));
    const handled = page.fire(new FakeRequest("https://other.example/c", true, page.main, true));
    await Promise.resolve();

    expect(allowedNav.decision).toBe("continue");
    expect(refusedNav.decision).toBe("abort");
    expect(refusedAsset.decision).toBe("abort");
    expect(asset.decision).toBe("continue");
    expect(subframe.decision).toBe("continue"); // mayRequest allowed it
    expect(handled.decision).toBeNull();
    expect(blocked).toEqual(["https://other.example/b"]);
    await session.close();
  });

  it("turns interception on before navigating, and reads back url and html", async () => {
    const page = new FakePage();
    const session = await browserSessionOpener({}, fakeLaunch(page))(guard([]));
    const out = await session.navigate("https://approved.example/a", signal);
    expect(out).toEqual({ url: "https://approved.example/a", html: page.html });
    await session.close();
  });

  it("clicks by text through evaluate, types and submits with Enter, screenshots PNG bytes", async () => {
    const page = new FakePage();
    const session = await browserSessionOpener({}, fakeLaunch(page))(guard([]));
    await session.click({ text: "Next" }, signal);
    // The function puppeteer receives actually ran in the page and clicked the element:
    // the fake only invokes functions, exactly like the real `evaluate`.
    expect(page.elements).toEqual([{ text: "Next", clicked: true }]);
    await session.type("#q", "hello", true, signal);
    expect(page.typed).toEqual([["#q", "hello"]]);
    expect(page.pressed).toEqual(["Enter"]);
    expect(await session.screenshot(signal)).toEqual(new Uint8Array([137, 80, 78, 71]));
    await expect(session.click({ text: "Missing" }, signal)).rejects.toThrow(/no link or button/);
    await session.close();
  });

  it("starts the navigation watch before the click and the Enter that may cause it", async () => {
    const page = new FakePage();
    const session = await browserSessionOpener({}, fakeLaunch(page))(guard([]));
    await session.click({ selector: "#go" }, signal);
    await session.type("#q", "hello", true, signal);
    expect(page.events.indexOf("wait")).toBeLessThan(page.events.indexOf("click"));
    expect(page.events.lastIndexOf("wait")).toBeLessThan(page.events.indexOf("press"));
    await session.close();
  });

  it("closes pages the visited page spawns, so no target runs without the guard", async () => {
    const page = new FakePage();
    const contexts: FakeContext[] = [];
    const session = await browserSessionOpener({}, fakeLaunch(page, [], contexts))(guard([]));
    const spawned = new FakePage();
    contexts[0]?.spawn(spawned);
    contexts[0]?.spawn(page); // the session's own page is never the one closed
    contexts[0]?.spawn(null); // a non-page target has nothing to close
    await Promise.resolve();
    await Promise.resolve();
    expect(spawned.closed).toBe(true);
    expect(page.closed).toBe(false);
    await session.close();
  });

  it("marks a vanished browser sessionGone so the tool closes and meters it", async () => {
    const page = new FakePage();
    page.failContent = new Error("Protocol error (Runtime.callFunctionOn): Target closed");
    const session = await browserSessionOpener({}, fakeLaunch(page))(guard([]));
    await expect(session.read(signal)).rejects.toMatchObject({ sessionGone: true });
    await session.close();
  });

  it("closes the context (dropping all session state) and then the browser", async () => {
    const page = new FakePage();
    const log: string[] = [];
    const session = await browserSessionOpener({}, fakeLaunch(page, log))(guard([]));
    await session.close();
    expect(log).toEqual(["context", "browser"]);
  });

  it("closes the browser when a session fails to open", async () => {
    const log: string[] = [];
    const launch: LaunchBrowser = async () => ({
      createBrowserContext: async () => {
        throw new Error("no capacity");
      },
      close: async () => {
        log.push("browser");
      },
    });
    await expect(browserSessionOpener({}, launch)(guard([]))).rejects.toThrow(/no capacity/);
    expect(log).toEqual(["browser"]);
  });

  it("closes a created context when setup fails after it, even if the browser won't close", async () => {
    const log: string[] = [];
    const launch: LaunchBrowser = async () => ({
      createBrowserContext: async () => new FakeContext(null, log, new Error("no page")) as never,
      close: async () => {
        log.push("browser");
        throw new Error("browser wedged");
      },
    });
    await expect(browserSessionOpener({}, launch)(guard([]))).rejects.toThrow(/no page/);
    expect(log).toEqual(["context", "browser"]);
  });
});
