// SPDX-License-Identifier: Apache-2.0
// The Memory screen (M3-15 AC1, AC3; m3-ux §3.7): notes with trust and source, search, edit as a
// new version, delete with the backup line and Undo, bulk delete and Recently learned.
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
  deletes: string[][];
  /** The next versions request fails, once. */
  versionsFail?: boolean;
  /** The next add fails, once. */
  addFail?: boolean;
  /** IDs the server reports it couldn't delete. */
  keep?: string[];
  /** A delete request with this many IDs fails with 500. */
  failBatchOf?: number;
}

/** Records each delete request as it starts, with its keepalive flag, in `window.deletes`. */
async function watchDeletes(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { deletes: boolean[] };
    w.deletes = [];
    const real = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/api/memory/delete")) w.deletes.push(init?.keepalive === true);
      return real(input, init);
    };
  });
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
    deletes: [],
  };
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings/memory", (route) =>
    route.fulfill({ json: { learnFromChats: true } }),
  );
  await page.route("/api/memory**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === "/api/memory/delete") {
      const { ids } = route.request().postDataJSON() as { ids: string[] };
      stub.deletes.push(ids);
      if (ids.length === stub.failBatchOf) return route.fulfill({ status: 500, json: {} });
      const failed = ids.filter((id) => (id === "n1" && ids.length > 1) || stub.keep?.includes(id));
      stub.notes = stub.notes.filter(
        (n) => !ids.includes(n.id as string) || failed.includes(n.id as string),
      );
      return route.fulfill({ json: { deleted: ids.filter((id) => !failed.includes(id)), failed } });
    }
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
  const recent = page.getByRole("region", { name: "Recently learned" });
  await expect(recent).toContainText("Prefers trains to planes");
  await expect(recent).toContainText("Learned 2 h ago");
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

test("holds a delete behind Undo with the backup line, then sends it", async ({ page }) => {
  const stub = await stubMemory(page);
  await page.clock.install();
  await page.goto("/memory");
  await page.getByRole("button", { name: "Delete: Sam lives in Leeds" }).click();
  const toast = page.getByRole("region", { name: "Notifications" });
  await expect(toast).toContainText(
    "Deleted 'Sam lives in Leeds'. A backup copy is kept for 30 days, then it's gone.",
  );
  await expect(page.getByText("Deleting…")).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(toast).toBeHidden();
  expect(stub.deletes).toEqual([]);
  await page.getByRole("button", { name: "Delete: Sam lives in Leeds" }).click();
  // The new toast lands where Undo was; with the pointer over it, its clock would stop.
  await page.mouse.move(0, 0);
  await page.clock.runFor(9_000);
  expect(stub.deletes).toEqual([]);
  await page.clock.runFor(1_500);
  await expect(page.getByText("Sam lives in Leeds", { exact: true })).toBeHidden();
  expect(stub.deletes).toEqual([["n1"]]);
});

test("bulk deletes after a confirmation that names the backup and the instructions", async ({
  page,
}) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all 4" }).click();
  await expect(page.getByRole("region", { name: "Selection" })).toContainText("4 selected");
  await page.getByRole("button", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete 4 notes?" });
  await expect(dialog).toContainText("A backup copy is kept for 30 days, then it's gone.");
  await expect(dialog).toContainText("This includes 1 standing instruction.");
  await axe(page);
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Deleted 3 of 4. I couldn't delete 'Sam lives in Leeds'.",
  );
  await expect(page.getByRole("region", { name: "Selection" })).toContainText("1 selected");
});

test("a search keeps the selection to the notes it shows", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("checkbox", { name: "Sam lives in Leeds" }).click({ force: true });
  const bar = page.getByRole("region", { name: "Selection" });
  await expect(bar).toContainText("1 selected");
  await page.getByLabel("Search notes").fill("tea");
  await expect(page.getByText("Sam lives in Leeds")).toBeHidden();
  await expect(bar).toContainText("0 selected");
  await expect(bar.getByRole("button", { name: "Delete…" })).toBeDisabled();
});

test("Select all leaves out a note waiting behind Undo", async ({ page }) => {
  const stub = await stubMemory(page);
  await page.clock.install();
  await page.goto("/memory");
  await expect(page.getByText("Likes green tea")).toBeVisible();
  // The Undo window stays open for the whole test.
  await page.clock.pauseAt(Date.now() + 1_000);
  await page.getByRole("button", { name: "Delete: Likes green tea" }).click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all 3" }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect.poll(() => stub.deletes).toEqual([["n4"], ["n1", "n2", "n3"]]);
});

test("a failed bulk delete keeps the notes selected", async ({ page }) => {
  await stubMemory(page);
  await page.route("/api/memory/delete", (route) => route.fulfill({ status: 500, json: {} }));
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all 4" }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(page.getByRole("alert")).toContainText("I couldn't delete that.");
  await expect(page.getByRole("region", { name: "Selection" })).toContainText("4 selected");
});

test("leaving the page sends a held delete and closes its toast", async ({ page }) => {
  const stub = await stubMemory(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Delete: Sam lives in Leeds" }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  await expect.poll(() => stub.deletes).toEqual([["n1"]]);
  await expect(page.getByRole("region", { name: "Notifications" })).toBeHidden();
  await expect(page.getByText("Sam lives in Leeds", { exact: true })).toBeHidden();
});

test("Select all over 1,000 notes deletes them in batches", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.notes = Array.from({ length: 1001 }, (_, i) => note({ id: `m${i}`, text: `Note ${i}` }));
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all 1001" }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect.poll(() => stub.deletes.map((ids) => ids.length)).toEqual([1000, 1]);
  await expect(page.getByRole("alert")).toBeHidden();
});

test("a dismissed delete goes out with keepalive, so leaving at once can't cancel it", async ({
  page,
}) => {
  await watchDeletes(page);
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Delete: Sam lives in Leeds" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { deletes: boolean[] }).deletes))
    .toEqual([true]);
});

test("leaving the page starts every batch of a held delete at once", async ({ page }) => {
  await watchDeletes(page);
  const stub = await stubMemory(page);
  stub.notes = Array.from({ length: 1001 }, (_, i) => note({ id: `m${i}`, text: `Note ${i}` }));
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all 1001" }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  // Counted in the same task as the event: a page that is really unloading runs nothing later.
  const started = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    return (window as unknown as { deletes: boolean[] }).deletes.length;
  });
  expect(started).toBe(2);
});

test("a page restored from the back/forward cache shows what the server kept", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.keep = ["n1"];
  await page.goto("/memory");
  await page.getByRole("button", { name: "Delete: Sam lives in Leeds" }).click();
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
  );
  await expect.poll(() => stub.deletes).toEqual([["n1"]]);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await expect(page.getByText("Sam lives in Leeds", { exact: true })).toBeVisible();
});

test("a failed later batch keeps what the first batch deleted gone", async ({ page }) => {
  const stub = await stubMemory(page);
  stub.notes = Array.from({ length: 1001 }, (_, i) => note({ id: `m${i}`, text: `Note ${i}` }));
  stub.failBatchOf = 1;
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("button", { name: "Select all 1001" }).click();
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Deleted 1000 of 1001. I couldn't delete 'Note 1000'.",
  );
  await expect(page.getByText("Note 0", { exact: true })).toBeHidden();
  await expect(page.getByRole("region", { name: "Selection" })).toContainText("1 selected");
});

test("Esc on a note's checkbox leaves selection mode", async ({ page }) => {
  await stubMemory(page);
  await page.goto("/memory");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.getByRole("checkbox", { name: "Sam lives in Leeds" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Selection" })).toBeHidden();
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
