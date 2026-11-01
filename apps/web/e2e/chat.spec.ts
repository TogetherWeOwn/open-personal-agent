// SPDX-License-Identifier: Apache-2.0
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const provider = (over: Record<string, unknown>) => ({
  id: "p1",
  kind: "openai-chat",
  api: "openai-responses",
  providerId: "openai",
  baseUrl: "https://api.openai.com/v1",
  providerName: "OpenAI",
  model: "gpt-4.1-mini",
  modelName: "GPT-4.1 mini",
  createdAt: Date.UTC(2026, 9, 20),
  key: {
    last4: "WXYZ",
    createdAt: Date.UTC(2026, 9, 20),
    updatedAt: Date.UTC(2026, 9, 20),
    lastUsedAt: null,
  },
  price: { inputUsdPerMTok: 0.4, outputUsdPerMTok: 1.6, verifiedAt: "2026-11-01", stale: false },
  ...over,
});
/** The settings view behind onboarding's gate and the composer's context chip (M3-06). */
const SETTINGS = {
  displayName: "Sam",
  about: "",
  onboarded: true,
  model: null,
  providers: [
    provider({}),
    provider({
      id: "p2",
      providerId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      providerName: "OpenRouter",
      model: "some/model",
      modelName: "some/model",
      price: null,
    }),
  ],
  roles: {
    chat: { provider: "p1", model: "gpt-4.1-mini" },
    background: { provider: "p1", model: "gpt-4.1-mini", default: true },
    embedding: null,
  },
};

// The chat loads nothing from another origin (ADR 0010 D7).
test.beforeEach(async ({ page, baseURL }) => {
  page.on("request", (req) => expect(new URL(req.url()).origin).toBe(baseURL));
  await page.route("/api/health", (route) => route.fulfill({ json: { status: "ok" } }));
  await page.route("/api/me", (route) => route.fulfill({ json: { id: "u", role: "owner" } }));
  await page.route("/api/settings", (route) => route.fulfill({ json: SETTINGS }));
  await page.route(/\/api\/attachments\/config/, (route) =>
    route.fulfill({
      json: {
        maxBytes: 10 * 1024 * 1024,
        accept: ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json",
        types: [],
        model: null,
      },
    }),
  );
});

/** Tabs to the composer, types, presses Enter and waits for the whole reply. */
async function sendByKeyboard(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "Message" });
  for (let i = 0; i < 10 && !(await box.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("a word at a time.");
}

test("a keyboard-only send streams a reply and announces it", async ({ page }) => {
  await page.goto("/");
  await sendByKeyboard(page, "Plan my week");
  await expect(page.getByRole("main").getByRole("heading")).toHaveText("Plan my week");
  await expect(page.getByRole("status")).toContainText("Assistant replied: ");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
});

test("an unhealthy server shows an alert; a draft stays with its chat", async ({ page }) => {
  await page.route("/api/health", (route) =>
    route.fulfill({ status: 503, json: { status: "degraded" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("isn't responding properly");
  await page.getByRole("textbox", { name: "Message" }).fill("Draft for the first chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await page.getByRole("option").last().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    "Draft for the first chat",
  );
});

test("Stop ends a reply", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill("Write an essay");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("log")).toContainText("Stopped before it finished.");
});

test("a refused send explains the limit and goes back to the composer", async ({ page }) => {
  await page.goto("/");
  const box = page.getByRole("textbox", { name: "Message" });
  for (const [text, title] of [
    ["/mock slow down", "Slow down"],
    ["/mock limit reached", "Daily limit reached"],
  ] as const) {
    await box.fill(text);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText(title);
    await expect(box).toHaveValue(text);
    await expect(page.getByRole("log")).toContainText("Hi. What can I help you with?");
  }
  await expect(
    page.getByRole("alert").getByRole("link", { name: "See today's usage" }),
  ).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
});

test("the context chip names the model and switches this chat to another (M3-06 AC3, AC6)", async ({
  page,
}) => {
  const pins: unknown[] = [];
  // The server answers with the thread's saved line for the switch (TWO-614).
  await page.route("/api/conversations/*/model", async (route) => {
    const pick = route.request().postDataJSON();
    pins.push(pick);
    const content = pick
      ? "Switched to some/model via OpenRouter"
      : "Switched to GPT-4.1 mini via OpenAI";
    const message = { id: `line-${pins.length}`, role: "system", status: "complete", content };
    await route.fulfill({ json: { message } });
  });
  await page.goto("/");
  const chip = page.getByRole("button", { name: /GPT-4\.1 mini · OpenAI, model for this chat/ });
  await expect(chip).toContainText("GPT-4.1 mini · OpenAI");
  await expect(page.getByText("about $0.09 per 100 messages")).toBeVisible();
  await chip.click();
  await page.getByRole("menuitem", { name: /some\/model · OpenRouter/ }).click();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText(
    "Switched to some/model via OpenRouter",
  );
  await expect(
    page.getByRole("button", { name: /some\/model · OpenRouter, model for this chat/ }),
  ).toBeVisible();
  // A chat the server doesn't have yet saves nothing: its first message carries the pick.
  expect(pins).toEqual([]);
  await sendByKeyboard(page, "Plan my week");
  // Back to the chat model clears the pin instead of naming a provider.
  await page.getByRole("button", { name: /model for this chat/ }).click();
  await page.getByRole("menuitem", { name: /Use my chat model/ }).click();
  await expect(page.getByRole("log")).toContainText("Switched to GPT-4.1 mini via OpenAI");
  await page.getByRole("button", { name: /model for this chat/ }).click();
  await page.getByRole("menuitem", { name: /some\/model · OpenRouter/ }).click();
  await expect.poll(() => pins).toEqual([null, { provider: "p2", model: "some/model" }]);
  // Each saved line takes the place of this tab's, so each switch reads once; the new chat's
  // first pick was never saved, so its line stays this tab's.
  await expect(page.getByRole("log").getByText(/^Switched to/)).toHaveCount(3);
});

test("a send right after a switch waits for the switch to save, so the reply uses it", async ({
  page,
}) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("/api/conversations/*/model", async (route) => {
    await held;
    await route.fulfill({ status: 204 });
  });
  await page.goto("/");
  await sendByKeyboard(page, "Plan my week");
  await page.getByRole("button", { name: /model for this chat/ }).click();
  await page.getByRole("menuitem", { name: /some\/model · OpenRouter/ }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("And next week?");
  await page.keyboard.press("Enter");
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("And next week?");
  // The send hasn't gone, so no turn has started, while the switch is still saving.
  await page.waitForTimeout(300);
  await expect(page.getByRole("status")).toHaveText("Switched to some/model via OpenRouter");
  release();
  await expect(page.getByRole("status")).toContainText("Assistant is working.");
  await expect(page.getByRole("status")).toContainText("Assistant replied");
});

test("a new chat's model can't switch while its first message is on its way", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message" }).fill("/mock slow start");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /model for this chat/ }).click();
  await expect(page.getByText("You can switch models once the reply starts.")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /some\/model · OpenRouter/ })).toBeDisabled();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toContainText("Assistant is working.");
  await page.getByRole("button", { name: /model for this chat/ }).click();
  await expect(page.getByRole("menuitem", { name: /some\/model · OpenRouter/ })).toBeEnabled();
  await expect(page.getByText("You can switch models once the reply starts.")).toHaveCount(0);
});

test("with no model set up, the chip says so and Send opens Settings › Models", async ({
  page,
}) => {
  await page.route("/api/settings", (route) =>
    route.fulfill({
      json: {
        ...SETTINGS,
        providers: [],
        roles: { chat: null, background: null, embedding: null },
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("link", { name: /No model set up/ })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Hello?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/settings\/models$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await expect(page.getByText("No model set up yet.")).toBeVisible();
});

test("what may be attached follows the chat's own model, even before the switch saves", async ({
  page,
}) => {
  const asked: string[] = [];
  await page.route(/\/api\/attachments\/config/, (route) => {
    asked.push(new URL(route.request().url()).search);
    const reads = route.request().url().includes("provider=p2");
    return route.fulfill({
      json: {
        maxBytes: 1024,
        accept: ".png,.txt",
        types: [{ ext: "png", mediaType: "image/png", kind: "image" }],
        model: { imageInput: reads, pdfInput: false },
      },
    });
  });
  await page.goto("/");
  // The Chat role's, asked for again once Settings says which model that is.
  await expect.poll(() => asked).toEqual(["", ""]);
  await page.getByRole("button", { name: /model for this chat/ }).click();
  await page.getByRole("menuitem", { name: /some\/model · OpenRouter/ }).click();
  await expect.poll(() => asked.at(-1)).toBe("?provider=p2&model=some%2Fmodel");
});

test("attaching a file: chips, plain refusals, and what the model can't read", async ({ page }) => {
  // A small cap and a model without image input, from config (M3-10 AC1–2).
  await page.route(/\/api\/attachments\/config/, (route) =>
    route.fulfill({
      json: {
        maxBytes: 1024,
        accept: ".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json",
        types: [
          { ext: "png", mediaType: "image/png", kind: "image" },
          { ext: "txt", mediaType: "text/plain", kind: "text" },
        ],
        model: { imageInput: false, pdfInput: false },
      },
    }),
  );
  await page.route(/\/api\/attachments$/, (route) =>
    route.fulfill({
      status: 201,
      json: { id: "f1", name: "cat.png", mediaType: "image/png", kind: "image", sizeBytes: 8 },
    }),
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await page.route(/\/api\/attachments\/f1$/, (route) =>
    route.fulfill({ contentType: "image/png", body: png }),
  );
  await page.goto("/");
  const input = page.locator('input[type="file"]');

  // A type we don't read and a file over the config's cap are refused in plain words.
  await input.setInputFiles({ name: "setup.exe", mimeType: "", buffer: Buffer.from("MZ") });
  await expect(page.getByRole("alert")).toContainText(
    "I can't read .exe files. I can read images, PDFs and text files.",
  );
  await page.getByRole("button", { name: "Remove setup.exe" }).click();
  await input.setInputFiles({
    name: "big.png",
    mimeType: "image/png",
    buffer: Buffer.alloc(2048),
  });
  await expect(page.getByRole("alert")).toContainText("Too large (max 1 KB)");
  await page.getByRole("button", { name: "Remove big.png" }).click();

  // A good pick uploads to a chip, with the warning that this model won't see it.
  await input.setInputFiles({ name: "cat.png", mimeType: "image/png", buffer: png });
  const chips = page.getByRole("list", { name: "Attached files" });
  await expect(chips).toContainText("cat.png");
  await expect(page.getByText("This model can't see images.")).toBeVisible();

  // Sending files alone works; the thread keeps the file and the same plain line.
  await page.getByRole("button", { name: "Send" }).click();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log).toContainText("a word at a time.");
  await expect(log.getByRole("link", { name: /cat\.png/ })).toBeVisible();
  await expect(log).toContainText("This model can't see images.");
  await expect(chips).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
});

test("returning from Settings reloads the model settings", async ({ page }) => {
  // A chat model is picked while the chat stays mounted behind the screen.
  let picked = false;
  await page.route("/api/settings", (route) =>
    route.fulfill({
      json: picked
        ? SETTINGS
        : {
            ...SETTINGS,
            providers: [],
            roles: { chat: null, background: null, embedding: null },
          },
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("link", { name: /No model set up/ })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/models$/);
  picked = true;
  await page.getByRole("link", { name: "Chats" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: /model for this chat/ })).toContainText(
    "GPT-4.1 mini",
  );
  await expect(page.getByRole("link", { name: /No model set up/ })).toHaveCount(0);
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1280]) {
    test(`chat, ${colorScheme}, ${width} px: axe clean, no sideways scroll, baseline`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width, height: width < 640 ? 667 : 800 });
      await page.goto("/");
      if (width < 640) {
        // Phones open on the list; a conversation fills the screen and "Chats" goes back.
        await expect(page.getByRole("main")).toBeHidden();
        await page.getByRole("option", { name: "New chat" }).click();
        await expect(page.getByRole("complementary")).toBeHidden();
      }
      await sendByKeyboard(page, "Plan my week");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target)}`)).toEqual([]);
      await expect(page).toHaveScreenshot(`chat-${colorScheme}-${width}.png`);
      if (width < 640) {
        await page.getByRole("button", { name: "Chats" }).click();
        await expect(page.getByRole("option", { name: "Plan my week" })).toBeVisible();
      }
    });
  }
}
