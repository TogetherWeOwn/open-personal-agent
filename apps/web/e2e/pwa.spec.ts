// SPDX-License-Identifier: Apache-2.0
// The installable app (M3-24 AC2; m3-ux §3.13): manifest and icons, an offline shell that keeps
// no API data, the install item, the iOS hint and the "new version" banner.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

async function signedIn(page: Page) {
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) => r.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (r) =>
    r.fulfill({
      json: {
        onboarded: true,
        providers: [],
        roles: { chat: null, background: null, embedding: null },
      },
    }),
  );
  await page.route("/api/approvals?status=pending", (r) => r.fulfill({ json: { batches: [] } }));
}

test("Chrome finds the app installable, with every icon the manifest names", async ({
  page,
  request,
}) => {
  await signedIn(page);
  await page.goto("/");
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ short_name: "Assistant", display: "standalone", scope: "/" });
  for (const icon of manifest.icons as { src: string; type: string }[]) {
    const res = await request.get(icon.src);
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain(icon.type);
  }
  expect((manifest.icons as { purpose: string }[]).some((i) => i.purpose === "maskable")).toBe(
    true,
  );
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  expect(installabilityErrors).toEqual([]);
});

test.describe("the offline shell", () => {
  test.use({ serviceWorkers: "allow", viewport: { width: 375, height: 667 } });

  test("opens with the nav and a calm message, keeps no API data, and reconnects", async ({
    page,
    context,
  }) => {
    // Signed out on the first visit, so nothing signed-in is there to be kept.
    await page.goto("/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      for (let i = 0; i < 50 && !(await caches.match("/")); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're offline");
    await expect(page.getByRole("main")).toContainText(
      "Your assistant keeps working on tasks in the cloud. I'll keep trying to reconnect.",
    );
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);

    // Only the page and its hashed files: never an /api answer.
    const kept = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) {
          urls.push(new URL(req.url).pathname);
        }
      }
      return urls;
    });
    expect(kept).toContain("/");
    for (const path of kept) expect(path === "/" || path.startsWith("/assets/")).toBe(true);

    await signedIn(page);
    await context.setOffline(false);
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "You're offline" })).toHaveCount(0);
  });
});

test("reconnects when the server comes back while the browser stays online", async ({ page }) => {
  // The browser never goes offline here, so no `online` event will fire: only the offline
  // screen's own retry can bring the app back.
  let down = true;
  await page.route("/api/health", (r) => r.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (r) =>
    down ? r.abort("failed") : r.fulfill({ json: { id: "u", role: "owner" } }),
  );
  await page.route("/api/settings", (r) =>
    r.fulfill({
      json: {
        onboarded: true,
        providers: [],
        roles: { chat: null, background: null, embedding: null },
      },
    }),
  );
  await page.route("/api/approvals?status=pending", (r) => r.fulfill({ json: { batches: [] } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { beforeRecovery: boolean }).beforeRecovery = true;
  });
  down = false;
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "You're offline" })).toHaveCount(0);
  // Still set: the app reconnected in place, without a reload.
  expect(
    await page.evaluate(() => (window as unknown as { beforeRecovery?: boolean }).beforeRecovery),
  ).toBe(true);
});

test("the account menu offers Install as an app only while the browser can", async ({ page }) => {
  await signedIn(page);
  await page.goto("/inbox");
  const account = page.getByRole("button", { name: "Account" });
  await account.click();
  await expect(page.getByRole("menuitem", { name: "Install as an app" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt") as Event & Record<string, unknown>;
    e.prompt = () => {
      (window as unknown as { prompted: boolean }).prompted = true;
      return Promise.resolve();
    };
    e.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(e);
  });
  await account.click();
  await page.getByRole("menuitem", { name: "Install as an app" }).click();
  expect(await page.evaluate(() => (window as unknown as { prompted?: boolean }).prompted)).toBe(
    true,
  );
  // A prompt is good for one ask.
  await account.click();
  await expect(page.getByRole("menuitem", { name: "Install as an app" })).toHaveCount(0);
});

test("a deploy shows a quiet Reload banner when the tab comes back, and never reloads by itself", async ({
  page,
}) => {
  await signedIn(page);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Inbox");
  await page.route("/", (route) =>
    route.request().resourceType() === "fetch"
      ? route.fulfill({
          contentType: "text/html",
          body: '<script type="module" crossorigin src="/assets/index-NEW.js"></script>',
        })
      : route.continue(),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const banner = page.getByRole("status").filter({ hasText: "A new version is ready." });
  await expect(banner).toBeVisible();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
});

test.describe("on iOS", () => {
  test.use({
    viewport: { width: 375, height: 667 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  });

  test("Settings › Deployment says where Add to Home Screen is", async ({ page }) => {
    await signedIn(page);
    await page.goto("/settings/deployment");
    const hint = page.getByRole("region", { name: "Install as an app" });
    await expect(hint).toContainText(/In Safari, tap Share\s*, then Add to Home Screen\./);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
  });
});
