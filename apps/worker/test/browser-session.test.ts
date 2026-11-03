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
  evaluateResult = true;
  failContent: Error | null = null;
  keyboard = {
    press: async (key: string) => {
      this.pressed.push(key);
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
  }
  async type(selector: string, text: string) {
    this.typed.push([selector, text]);
  }
  async evaluate(_fn: string, _arg: string) {
    return this.evaluateResult;
  }
  async screenshot() {
    return new Uint8Array([137, 80, 78, 71]);
  }
  async close() {}
}

function fakeLaunch(page: FakePage, log: string[] = []): LaunchBrowser {
  return async () => ({
    createBrowserContext: async () => ({
      newPage: async () => page as never,
      close: async () => {
        log.push("context");
      },
    }),
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
    await session.type("#q", "hello", true, signal);
    expect(page.typed).toEqual([["#q", "hello"]]);
    expect(page.pressed).toEqual(["Enter"]);
    expect(await session.screenshot(signal)).toEqual(new Uint8Array([137, 80, 78, 71]));
    page.evaluateResult = false;
    await expect(session.click({ text: "Missing" }, signal)).rejects.toThrow(/no link or button/);
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
});
