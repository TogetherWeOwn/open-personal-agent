// SPDX-License-Identifier: Apache-2.0
// Activity › Outputs (M3-11; m3-ux §3.6): the library, the per-chat view, previews (HTML in a
// frame with an empty `sandbox`), Download, the source-run link and Delete with Undo.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";

test.use({ locale: "en-US", timezoneId: "Europe/London" });

const file = (over: { id: string; name: string } & Record<string, unknown>) => ({
  mediaType: "text/markdown",
  sizeBytes: 2048,
  conversationId: "trip",
  conversationTitle: "Orkney trip",
  taskId: null,
  turnId: "turn-1",
  createdAt: Date.UTC(2026, 10, 1, 9),
  ...over,
});
const FILES = [
  file({ id: "plan", name: "trip-plan.md" }),
  file({ id: "page", name: "ferries.html", mediaType: "text/html", sizeBytes: 900 }),
  file({
    id: "totals",
    name: "totals.csv",
    mediaType: "text/csv",
    conversationId: "work",
    conversationTitle: "Work",
    taskId: "t1",
  }),
];

/** Serves `/api/artifacts*` from `files`, and records the requests the screen made. */
async function serve(page: Page, files = FILES) {
  const seen: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/artifacts"),
    (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      seen.push(`${req.method()} ${url.pathname}${url.search}`);
      const [, , , id, content] = url.pathname.split("/");
      if (req.method() === "DELETE") return route.fulfill({ status: 204 });
      if (!id) {
        const chat = url.searchParams.get("conversationId");
        const after = url.searchParams.get("beforeId");
        const mine = files.filter((f) => !chat || f.conversationId === chat);
        const from = after ? mine.findIndex((f) => f.id === after) + 1 : 0;
        return route.fulfill({ json: { artifacts: mine.slice(from, from + 100) } });
      }
      const found = files.find((f) => f.id === id);
      if (!found) return route.fulfill({ status: 404, json: { error: "not_found" } });
      if (!content) return route.fulfill({ json: found });
      const body =
        found.mediaType === "text/html"
          ? "<p>Ferry times</p><script>parent.document.title = 'escaped'</script>"
          : "# Kirkwall\n\nFerry at **06:30**.";
      return route.fulfill({ body, contentType: found.mediaType });
    },
  );
  return seen;
}

test.beforeEach(async ({ page }) => {
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/conversations", (route) =>
    route.fulfill({
      json: {
        conversations: [
          { id: "trip", title: "Orkney trip", updatedAt: 2 },
          { id: "work", title: "Work", updatedAt: 1 },
        ],
      },
    }),
  );
});

const h1 = (page: Page) => page.getByRole("heading", { level: 1 });
const files = (page: Page) => page.getByRole("list", { name: "Files" }).getByRole("listitem");

async function axe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

test("lists every file with its type, size, chat and date", async ({ page }) => {
  await serve(page);
  await page.goto("/activity/outputs");
  await expect(h1(page)).toHaveText("Outputs");
  const items = files(page);
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText("trip-plan.md");
  await expect(items.first()).toContainText("Markdown · 2 KB");
  await expect(items.first()).toContainText("Orkney trip · Nov 1, 2026");
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await axe(page, width);
  }
});

test("filters to one chat, in the address too, and back to all files", async ({ page }) => {
  const seen = await serve(page);
  await page.goto("/activity/outputs");
  await page.getByLabel("Chat", { exact: true }).selectOption("work");
  await expect(page).toHaveURL(/\/activity\/outputs\?conversation=work$/);
  await expect(files(page)).toHaveCount(1);
  expect(seen).toContain("GET /api/artifacts?conversationId=work");

  await page.goto("/activity/outputs?conversation=empty");
  await expect(page.getByRole("heading", { name: "No files from this chat yet." })).toBeVisible();
  await page.getByRole("button", { name: "All files" }).click();
  await expect(page).toHaveURL(/\/activity\/outputs$/);
  await expect(files(page)).toHaveCount(3);
});

test("pages on the last file's time and ID, so files made together all show", async ({ page }) => {
  // 101 files from one millisecond: the second page has to start inside the tie.
  const many = Array.from({ length: 101 }, (_, i) => file({ id: `f${i}`, name: `f${i}.md` }));
  const seen = await serve(page, many);
  await page.goto("/activity/outputs");
  await expect(files(page)).toHaveCount(100);
  await page.getByRole("button", { name: "Show older files" }).click();
  await expect(files(page)).toHaveCount(101);
  expect(seen).toContain(`GET /api/artifacts?before=${many[99]?.createdAt}&beforeId=f99`);
});

test("shows the empty state when nothing has been made yet", async ({ page }) => {
  await serve(page, []);
  await page.goto("/activity/outputs");
  await expect(
    page.getByRole("heading", {
      name: "Files I make for you show up here, like summaries and reports.",
    }),
  ).toBeVisible();
});

test("previews Markdown with Download and a link to its source chat", async ({ page }) => {
  await serve(page);
  await page.goto("/activity/outputs");
  await page.getByRole("link", { name: /trip-plan\.md/ }).click();
  await expect(page).toHaveURL(/\/activity\/outputs\/plan$/);
  await expect(h1(page)).toHaveText("trip-plan.md");
  await expect(page.getByRole("heading", { name: "Kirkwall" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    "/api/artifacts/plan/content?download=1",
  );
  await expect(page.getByRole("link", { name: "Open source chat" })).toHaveAttribute(
    "href",
    "/c/trip",
  );
  await axe(page, 1280);
});

test("links a task's file to its task", async ({ page }) => {
  await serve(page);
  await page.goto("/activity/outputs/totals");
  await expect(page.getByRole("link", { name: "Open source task" })).toHaveAttribute(
    "href",
    "/activity/tasks/t1",
  );
});

test("previews HTML in a frame with an empty sandbox, so its script never runs", async ({
  page,
}) => {
  await serve(page);
  await page.goto("/activity/outputs/page");
  await expect(
    page.getByText(
      "Shown in a locked-down frame. Links and scripts in it can't reach your account.",
    ),
  ).toBeVisible();
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("title", "Preview of ferries.html");
  await expect(page.frameLocator("iframe").getByText("Ferry times")).toBeVisible();
  await expect(page).toHaveTitle("ferries.html · Open Personal Agent");
});

test("deletes after the Undo window, and Undo keeps the file", async ({ page }) => {
  await page.clock.install();
  const seen = await serve(page);
  await page.goto("/activity/outputs/plan");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/activity\/outputs\?conversation=trip$/);
  await expect(page.getByRole("status").filter({ hasText: "Deleted trip-plan.md." })).toBeVisible();
  await expect(page.getByRole("link", { name: /trip-plan\.md/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("link", { name: /trip-plan\.md/ })).toBeVisible();
  await page.clock.runFor(11_000);
  expect(seen.filter((r) => r.startsWith("DELETE"))).toEqual([]);

  await page.getByRole("link", { name: /trip-plan\.md/ }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await page.clock.runFor(11_000);
  await expect
    .poll(() => seen.filter((r) => r.startsWith("DELETE")))
    .toEqual(["DELETE /api/artifacts/plan"]);
});

test("says so when the file doesn't exist", async ({ page }) => {
  await serve(page);
  await page.goto("/activity/outputs/nope");
  await expect(
    page.getByRole("heading", { name: "This file doesn't exist or was deleted." }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "All files" })).toBeVisible();
});

test("the chat's menu opens its files", async ({ page }) => {
  await serve(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Chat options" }).click();
  await page.getByRole("menuitem", { name: "Files in this chat" }).click();
  await expect(page).toHaveURL(/\/activity\/outputs\?conversation=.+$/);
  await expect(h1(page)).toHaveText("Outputs");
});
