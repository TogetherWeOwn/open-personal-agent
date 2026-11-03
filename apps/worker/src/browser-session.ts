// SPDX-License-Identifier: Apache-2.0
// The Worker's `BrowserSession` adapter (M4-09): Cloudflare Browser Rendering driven over CDP by
// `@cloudflare/puppeteer`. This is the only place a browser exists; the `browser` tool owns all
// policy and hands this adapter a guard, consulted through request interception before the
// browser acts — a refused main-frame navigation is aborted (and reported back through the
// guard), a refused request is aborted, everything else continues. Every session is a fresh,
// isolated browser context: no cookies, storage or profile are shared with — or survive into —
// any other session (logged-out only), and there is no profile knob here to swap.
//
// The puppeteer objects are typed structurally below, so tests drive the interception decisions
// against a fake page without launching a browser; the real library is imported lazily, only
// when a session is actually opened.
import type { BrowserGuard, BrowserPage, BrowserSession } from "@opa/tools-builtin";

/** A request puppeteer paused for our decision, as much of it as the guard needs. */
interface InterceptedRequest {
  url(): string;
  isNavigationRequest(): boolean;
  isInterceptResolutionHandled(): boolean;
  frame(): unknown;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/** The page surface the adapter uses. */
interface PuppeteerPage {
  mainFrame(): unknown;
  setRequestInterception(value: boolean): Promise<void>;
  on(event: "request", listener: (request: InterceptedRequest) => void): void;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  waitForNavigation(options?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  url(): string;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  evaluate(pageFunction: string, arg: string): Promise<boolean>;
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface PuppeteerContext {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
}

interface PuppeteerBrowser {
  createBrowserContext(): Promise<PuppeteerContext>;
  close(): Promise<void>;
}

/** Launches a browser on the binding. Tests inject a fake; production loads the real library. */
export type LaunchBrowser = (binding: unknown) => Promise<PuppeteerBrowser>;

const launchReal: LaunchBrowser = async (binding) => {
  const puppeteer = (await import("@cloudflare/puppeteer")).default;
  // The library's own types are wider than the structural surface above; the cast is the seam.
  return (await puppeteer.launch(binding as never)) as unknown as PuppeteerBrowser;
};

/**
 * Puppeteer's words for a browser that is no longer there. The tool closes (and meters) the
 * session and tells the model to open the page again, instead of guessing at a new identity.
 */
const GONE = /target closed|session closed|connection closed|disconnected|protocol error/i;

function translate(error: unknown): never {
  if (error instanceof Error && GONE.test(error.message))
    throw Object.assign(new Error("the browser session ended"), { sessionGone: true });
  throw error;
}

const NAV_TIMEOUT_MS = 30_000;
/** How long a click or submit gets to turn into a navigation before the page is read as-is. */
const SETTLE_MS = 1_500;

class WorkerBrowserSession implements BrowserSession {
  readonly #page: PuppeteerPage;
  readonly #context: PuppeteerContext;
  readonly #browser: PuppeteerBrowser;

  constructor(page: PuppeteerPage, context: PuppeteerContext, browser: PuppeteerBrowser) {
    this.#page = page;
    this.#context = context;
    this.#browser = browser;
  }

  async #snapshot(): Promise<BrowserPage> {
    return { url: this.#page.url(), html: await this.#page.content() };
  }

  /** A click or Enter may navigate (the guard decides where to); give it a moment, then read. */
  async #settled(signal: AbortSignal): Promise<BrowserPage> {
    await Promise.race([
      this.#page
        .waitForNavigation({ waitUntil: "load", timeout: NAV_TIMEOUT_MS, signal })
        .catch(() => {}),
      new Promise((r) => setTimeout(r, SETTLE_MS)),
    ]);
    return this.#snapshot();
  }

  async navigate(url: string, signal: AbortSignal): Promise<BrowserPage> {
    try {
      await this.#page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS, signal });
      return await this.#snapshot();
    } catch (error) {
      // A page whose main navigation the guard refused still leaves the browser usable: the
      // goto fails, but where the frame actually is (the previous page) is the honest answer,
      // and the tool names the blocked URL from the guard's notes.
      if (error instanceof Error && /ERR_|Navigation timeout|net::/i.test(error.message)) {
        try {
          return await this.#snapshot();
        } catch {
          translate(error);
        }
      }
      translate(error);
    }
  }

  async click(target: { selector?: string; text?: string }, signal: AbortSignal) {
    try {
      if (target.selector) {
        await this.#page.click(target.selector);
      } else if (target.text) {
        // Click the first link or button whose visible text matches, as a person would look
        // for it. The text travels as an argument, never string-built into page code.
        const found = await this.#page.evaluate(
          `(text) => {
            const want = text.trim().toLowerCase();
            for (const el of document.querySelectorAll("a, button, [role='link'], [role='button']")) {
              if ((el.textContent ?? "").trim().toLowerCase() === want) { el.click(); return true; }
            }
            return false;
          }`,
          target.text,
        );
        if (!found) throw new Error(`no link or button reads "${target.text}"`);
      } else {
        throw new Error("click needs a selector or text");
      }
      return await this.#settled(signal);
    } catch (error) {
      translate(error);
    }
  }

  async type(selector: string, text: string, submit: boolean, signal: AbortSignal) {
    try {
      await this.#page.type(selector, text);
      if (submit) await this.#page.keyboard.press("Enter");
      return submit ? await this.#settled(signal) : await this.#snapshot();
    } catch (error) {
      translate(error);
    }
  }

  async read(): Promise<BrowserPage> {
    try {
      return await this.#snapshot();
    } catch (error) {
      translate(error);
    }
  }

  async screenshot(): Promise<Uint8Array> {
    try {
      return await this.#page.screenshot({ type: "png" });
    } catch (error) {
      translate(error);
    }
  }

  async close() {
    // Closing the context drops every cookie and storage the session gathered; closing the
    // browser ends the billed session. Either failing must not strand the other.
    try {
      await this.#context.close();
    } catch {}
    try {
      await this.#browser.close();
    } catch {}
  }
}

/**
 * `openBrowserSession` for the Worker, over the `BROWSER` Browser Rendering binding. Absent
 * binding, absent tool: the composition only passes this where `env.BROWSER` exists.
 */
export function browserSessionOpener(
  binding: unknown,
  launch: LaunchBrowser = launchReal,
): (guard: BrowserGuard) => Promise<BrowserSession> {
  return async (guard) => {
    const browser = await launch(binding);
    try {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      // Interception goes on before anything navigates, and stays on for the session's life:
      // the guard is the tool's, consulted fresh for every request.
      page.on("request", (request) => {
        if (request.isInterceptResolutionHandled()) return;
        const url = request.url();
        const navigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
        const allowed = navigation ? guard.mayNavigate(url) : guard.mayRequest(url);
        if (allowed) {
          void request.continue().catch(() => {});
        } else {
          if (navigation) guard.noteBlocked(url);
          void request.abort("blockedbyclient").catch(() => {});
        }
      });
      await page.setRequestInterception(true);
      return new WorkerBrowserSession(page, context, browser);
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  };
}
