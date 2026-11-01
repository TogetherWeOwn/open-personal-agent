// SPDX-License-Identifier: Apache-2.0
// The setup checklist (M3-24 AC1, A-O2; m3-ux §3.12): onboarding's skipped steps on a new chat's
// empty state and on Settings › Assistant.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

type Setup = { skipped: string[] | null; hidden: boolean };

/** A stateful stand-in for the settings routes the checklist reads and writes. */
async function stub(page: Page, initial: Setup | "fail") {
  const setup: Setup = initial === "fail" ? { skipped: null, hidden: false } : { ...initial };
  const bodies: unknown[] = [];
  let reads = 0;
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route(/\/api\/attachments\/config/, (route) =>
    route.fulfill({ json: { maxBytes: 1024, accept: ".txt", types: [], model: null } }),
  );
  await page.route("/api/settings", (route) => {
    // The first read is the app's onboarding gate; a failing stub fails every one after it.
    if (initial === "fail" && reads++ > 0) return route.fulfill({ status: 500 });
    return route.fulfill({
      json: { displayName: "Sam", about: "", onboarded: true, model: null, setup },
    });
  });
  await page.route("/api/settings/setup", (route) => {
    const body = route.request().postDataJSON();
    bodies.push(body);
    if (typeof body.hidden === "boolean") setup.hidden = body.hidden;
    if (body.done) setup.skipped = (setup.skipped ?? []).filter((s) => s !== body.done);
    return route.fulfill({ json: setup });
  });
  await page.route("/api/settings/profile", (route) => {
    bodies.push(route.request().postDataJSON());
    setup.skipped = (setup.skipped ?? []).filter((s) => s !== "about");
    return route.fulfill({ status: 204 });
  });
  return { setup, bodies };
}

const card = (page: Page) => page.getByRole("region", { name: /Finish setting up/ });

test("lists the skipped steps on a new chat and finishes them in place", async ({ page }) => {
  const { bodies } = await stub(page, { skipped: ["safety", "chat"], hidden: false });
  await page.goto("/");
  await expect(card(page).getByRole("heading")).toHaveText("Finish setting up · 2 of 4 done");
  await expect(card(page).getByRole("meter")).toHaveAttribute("aria-valuenow", "2");
  await expect(card(page).getByRole("listitem").first()).toHaveText("✓ About youDone");
  expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);

  // Safety opens the explainer as a sheet, with the same sample card.
  await card(page).getByRole("button", { name: "Show me" }).click();
  const sheet = page.getByRole("dialog", { name: "How I ask before acting" });
  await expect(sheet.getByRole("region", { name: "Send email · Needs your OK" })).toBeVisible();
  expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
  await sheet.getByRole("button", { name: "Got it" }).click();
  await expect(card(page).getByRole("heading")).toHaveText("Finish setting up · 3 of 4 done");

  // First chat inserts the suggestions; one fills the composer, unsent.
  await card(page).getByRole("button", { name: "Show suggestions" }).click();
  await card(page).getByRole("button", { name: "Remember that I'm vegetarian." }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Remember that I'm vegetarian.",
  );
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText("All set.", { exact: true })).toBeVisible();
  expect(bodies).toEqual([{ done: "safety" }, { done: "chat" }]);

  // "All set." shows once: the next new chat has no card at all.
  await page.reload();
  await expect(page.getByText("Hi. What can I help you with?")).toBeVisible();
  await expect(page.getByText("All set.", { exact: true })).toHaveCount(0);
});

test("Hide takes it off the chat; Settings › Assistant keeps it and finishes About you", async ({
  page,
}) => {
  const { bodies } = await stub(page, { skipped: ["about", "costs"], hidden: false });
  await page.goto("/");
  await card(page).getByRole("button", { name: "Setup checklist options" }).click();
  await page.getByRole("menuitem", { name: "Hide" }).click();
  await expect(card(page)).toHaveCount(0);
  expect(bodies).toEqual([{ hidden: true }]);

  await page.goto("/settings/assistant");
  await expect(card(page).getByRole("heading")).toHaveText("Finish setting up · 2 of 4 done");
  await expect(card(page).getByRole("link", { name: "Review limits" })).toHaveAttribute(
    "href",
    "/settings/spending",
  );
  expect(await new AxeBuilder({ page }).analyze()).toHaveProperty("violations", []);
  await page.getByLabel("Anything it should know about you? (optional)").fill("I garden.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect(card(page).getByRole("heading")).toHaveText("Finish setting up · 3 of 4 done");
  expect(bodies).toContainEqual({ displayName: "Sam", about: "I garden." });
});

test("nothing skipped shows no checklist anywhere", async ({ page }) => {
  await stub(page, { skipped: null, hidden: false });
  await page.goto("/");
  await expect(page.getByText("Hi. What can I help you with?")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await page.goto("/settings/assistant");
  await expect(page.getByLabel("What should your assistant call you?")).toHaveValue("Sam");
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByText("Setup complete.")).toHaveCount(0);
});

test("every skip finished says Setup complete in Settings, and nothing on the chat", async ({
  page,
}) => {
  await stub(page, { skipped: [], hidden: false });
  await page.goto("/");
  await expect(page.getByText("Hi. What can I help you with?")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await page.goto("/settings/assistant");
  await expect(page.getByText("Setup complete.")).toBeVisible();
});

test("a failed load leaves the card out silently", async ({ page }) => {
  await stub(page, "fail");
  await page.goto("/");
  await expect(page.getByText("Hi. What can I help you with?")).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
