// SPDX-License-Identifier: Apache-2.0
// The Memory screen (M3-15 AC1; m3-ux §3.7): notes with trust and source, search, edit as a new
// version and add.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

test.use({ locale: "en-GB", timezoneId: "Europe/London" });

const HOUR = 3_600_000;
const NOW = Date.now();

const note = (over: Record<string, unknown>) => ({
  id: "n1",
  kind: "fact",
  text: "Sam lives in Leeds",
  trust: "user",
  op: "create",
  source: "chat",
  sourceRef: null,
  sourceExcerpt: null,
  conversation: { id: "c1", title: "Moving house" },
  createdAt: NOW - 30 * 86_400_000,
  lastUsedAt: null,
  expiresAt: null,
  ...over,
});

interface Stub {
  notes: Record<string, unknown>[];
  /** The next versions request fails, once. */
  versionsFail?: boolean;
  /** The next add fails, once. */
  addFail?: boolean;
}

async function stubMemory(page: Page): Promise<Stub> {
  const stub: Stub = {
    notes: [
      note({}),
      note({
        id: "n2",
        text: "Prefers trains to planes",
        trust: "inferred",
        createdAt: NOW - 2 * HOUR,
      }),
      note({
        id: "n3",
        kind: "instruction",
        text: "Always answer in British English",
        source: "memory_screen",
        conversation: null,
      }),
      note({
        id: "n4",
        text: "Likes green tea",
        op: "update",
        trust: "external",
        source: "web",
        sourceRef: "https://example.com/tea",
      }),
    ],
  };
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/memory**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path.endsWith("/versions")) {
      if (stub.versionsFail) {
        stub.versionsFail = false;
        return route.fulfill({ status: 500, json: { error: "internal_error" } });
      }
      return route.fulfill({ json: { versions: [note({ id: "old", text: "Likes tea" })] } });
    }
    if (method === "PUT") {
      const { text } = route.request().postDataJSON() as { text: string };
      if (text === "fail") return route.fulfill({ status: 500, json: { error: "internal_error" } });
      const id = path.split("/").at(-1);
      if (!stub.notes.some((n) => n.id === id)) {
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      }
      const next = note({
        id: `${id}-v2`,
        text,
        op: "update",
        source: "memory_screen",
        conversation: null,
      });
      stub.notes = stub.notes.map((n) => (n.id === id ? next : n));
      return route.fulfill({ json: { memory: next } });
    }
    if (method === "POST") {
      if (stub.addFail) {
        stub.addFail = false;
        return route.fulfill({ status: 500, json: { error: "internal_error" } });
      }
      const { text, kind } = route.request().postDataJSON() as { text: string; kind?: string };
      const added = note({
        id: "n9",
        kind: kind ?? "fact",
        text,
        source: "memory_screen",
        conversation: null,
        createdAt: Date.now(),
      });
      stub.notes.unshift(added);
      return route.fulfill({ json: { memory: added } });
    }
    const q = url.searchParams.get("q")?.toLowerCase() ?? "";
    return route.fulfill({
      json: { memories: stub.notes.filter((n) => (n.text as string).toLowerCase().includes(q)) },
    });
  });
  return stub;
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
}

test("lists notes in sections with trust, source and dates", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Memory");
  const about = page.getByRole("region", { name: "About you" });
  await expect(about).toContainText("Always answer in British English");
  await expect(about.getByLabel("Standing instruction")).toBeVisible();
  const notes = page.getByRole("region", { name: "Notes" });
  await expect(notes).toContainText("You told me");
  await expect(notes).toContainText("From a web page or file");
  await expect(
    notes.getByRole("link", { name: "From a chat: Moving house" }).first(),
  ).toHaveAttribute("href", "/c/c1");
  await expect(notes.getByRole("link", { name: /example\.com/ })).toHaveAttribute(
    "target",
    "_blank",
  );
  await notes.getByRole("button", { name: "Earlier versions" }).click();
  await expect(notes).toContainText("Likes tea");
  await axe(page);
});

test("searches, and offers to clear a search with no match", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByLabel("Search notes").fill("lisbon");
  await expect(page.getByRole("heading", { name: 'Nothing matches "lisbon".' })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByText("Sam lives in Leeds")).toBeVisible();
});

test("edits in place: Esc cancels, a failed save keeps the text, a save makes a new version", async ({
  page,
}) => {
  await stubMemory(page);
  await page.goto("/memory");
  const edit = page.getByRole("button", { name: "Edit: Sam lives in Leeds" });
  await edit.click();
  await page.getByLabel("Edit note").fill("half");
  await page.keyboard.press("Escape");
  await expect(edit).toBeFocused();
  await edit.click();
  await page.getByLabel("Edit note").fill("fail");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("That didn't work. Try again.")).toBeVisible();
  await expect(page.getByLabel("Edit note")).toHaveValue("fail");
  await page.getByLabel("Edit note").fill("Sam lives in Paris");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Sam lives in Paris")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit: Sam lives in Paris" })).toBeFocused();
});

test("adds a note typed on the screen", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByLabel("Add a note").fill("Allergic to peanuts");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("region", { name: "Notes" })).toContainText("Allergic to peanuts");
});

test("a malformed source link doesn't stop the screen opening", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.notes.push(note({ id: "n5", text: "Odd link", source: "web", sourceRef: "https://[bad" }));
  await page.goto("/memory");
  await expect(page.getByText("Odd link")).toBeVisible();
  await expect(page.getByText("Sam lives in Leeds")).toBeVisible();
});

test("a note changed meanwhile refreshes the list and says so", async ({ page }) => {
  const stub = await stubMemory(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Edit: Sam lives in Leeds" }).click();
  stub.notes = stub.notes.map((n) =>
    n.id === "n1" ? note({ id: "n1-v9", text: "Sam lives in York", op: "update" }) : n,
  );
  await page.getByLabel("Edit note").fill("Sam lives in Paris");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("That note changed or was deleted meanwhile");
  await expect(page.getByText("Sam lives in York")).toBeVisible();
  // A save that works afterwards clears the warning.
  await page.getByRole("button", { name: "Edit: Sam lives in York" }).click();
  await page.getByLabel("Edit note").fill("Sam lives in Paris");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Sam lives in Paris")).toBeVisible();
  await expect(page.getByRole("alert")).toBeHidden();
});

test("earlier versions load on a second try after a failure", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.versionsFail = true;
  await page.goto("/memory");
  const versions = page.getByRole("button", { name: "Earlier versions" });
  await versions.click();
  await expect(page.getByText("I couldn't load the earlier versions.")).toBeVisible();
  await versions.click();
  await versions.click();
  await expect(page.getByRole("region", { name: "Notes" })).toContainText("Likes tea");
  await expect(page.getByText("I couldn't load the earlier versions.")).toBeHidden();
});

test("a failed add clears its error once a retry works", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.addFail = true;
  await page.goto("/memory");
  await page.getByLabel("Add a note").fill("Allergic to peanuts");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("That didn't work. Try again.");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("region", { name: "Notes" })).toContainText("Allergic to peanuts");
  await expect(page.getByRole("alert")).toBeHidden();
});

test("an edit that no longer matches the search leaves the results", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByLabel("Search notes").fill("leeds");
  await expect(page.getByText("Likes green tea")).toBeHidden();
  await page.getByRole("button", { name: "Edit: Sam lives in Leeds" }).click();
  await page.getByLabel("Edit note").fill("Sam lives in Paris");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: 'Nothing matches "leeds".' })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Saved. It no longer matches your search.");
});

test("adds a standing instruction to About you", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByLabel("Add a note").fill("Keep replies short");
  await page.getByText("Make it a standing instruction").click();
  await expect(
    page.getByRole("checkbox", { name: "Make it a standing instruction" }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("region", { name: "About you" })).toContainText("Keep replies short");
});

test("says when search shows only the first 100 matches", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.notes = Array.from({ length: 100 }, (_, i) => note({ id: `m${i}`, text: `Tea ${i}` }));
  await page.goto("/memory");
  await expect(page.getByText(/first 100/)).toBeHidden();
  await page.getByLabel("Search notes").fill("tea");
  await expect(
    page.getByText("Showing the first 100 matches. Add a word to narrow it."),
  ).toBeVisible();
});

test("shows the empty state", async ({ page }) => {
  await stubMemory(page);
  await page.route("/api/memory", (route) => route.fulfill({ json: { memories: [] } }));
  await page.goto("/memory");
  await expect(
    page.getByRole("heading", {
      name: "I'll remember things you tell me, like your preferences and ongoing projects.",
    }),
  ).toBeVisible();
});

for (const width of [375, 1280]) {
  test(`fits ${width} px with no axe violations`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubMemory(page);
    await page.goto("/memory");
    await expect(page.getByText("Sam lives in Leeds")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await axe(page);
  });
}
