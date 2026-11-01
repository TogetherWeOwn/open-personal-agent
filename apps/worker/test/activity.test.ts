// SPDX-License-Identifier: Apache-2.0
// Activity › Log's API (M3-19 AC3): the session's own audit rows from the last 365 days, newest
// first, with kind and title; filtered by kind, searched by text or title, paged by row ID.
import { DAY_MS } from "@opa/db/retention";
import { describe, expect, it } from "vitest";
import { Browser, claim, db, freshDatabase } from "./helpers/app";

freshDatabase();

type Entry = {
  id: number;
  at: number;
  kind: string;
  title: string;
  action: string;
  result: string;
  target: string | null;
  detail: unknown;
};
type Page = { entries: Entry[]; next: number | null; retentionDays: number };

const row = (
  userId: string | null,
  action: string,
  o: { result?: string; target?: string; detail?: string; at?: number } = {},
) =>
  db
    .prepare(
      "INSERT INTO audit_log (user_id, action, module, target_id, result, detail, created_at) VALUES (?, ?, 'test', ?, ?, ?, ?)",
    )
    .bind(userId, action, o.target ?? null, o.result ?? "ok", o.detail ?? null, o.at ?? Date.now());

const read = async (browser: Browser, query = "") => {
  const res = await browser.req(`/api/activity/log${query}`);
  expect(res.status).toBe(200);
  return res.json<Page>();
};

/** The deployment, its owner and a second user, each with rows of their own. */
async function seeded() {
  const claimed = await claim();
  await db.prepare("INSERT INTO users (id, display_name, role) VALUES ('u2', 'B', 'member')").run();
  const scope = JSON.stringify({ kind: "tool", tool: "send_email" });
  await db.batch([
    db.prepare("DELETE FROM audit_log"),
    row(claimed.owner, "auth.login", { at: Date.now() - 400 * DAY_MS }),
    row(claimed.owner, "auth.login"),
    row(claimed.owner, "approval.approve", {
      target: "b1/a1",
      detail: JSON.stringify({ tool: "send_email", scope }),
    }),
    row(claimed.owner, "approval.execute", {
      result: "denied",
      target: "b1/a1",
      detail: JSON.stringify({ reason: "denied_at_recheck" }),
    }),
    row(claimed.owner, "policy.override", {
      target: "send_email",
      detail: JSON.stringify({ from: "ask", to: "auto", riskClass: "egress" }),
    }),
    row(claimed.owner, "vault.decrypt", { target: "s1", detail: "model_key" }),
    row(claimed.owner, "vault.decrypt", { result: "denied", target: "s1", detail: "model_key" }),
    row(claimed.owner, "approval.claim", { target: "b1/a1" }),
    row(claimed.owner, "settings.spending", {
      detail: JSON.stringify({ dailyCapMicroUsd: { from: 5_000_000, to: 100_000_000 } }),
    }),
    row(claimed.owner, "something.new", { detail: "100% literal" }),
    row("u2", "auth.login", { detail: "u2-secret-marker" }),
    row(null, "setup.token", { result: "denied" }),
  ]);
  return claimed;
}

describe("activity log", () => {
  it("lists the user's own rows of the last 365 days, newest first, without bookkeeping", async () => {
    const { browser } = await seeded();
    const page = await read(browser);
    expect(page.retentionDays).toBe(365);
    expect(page.next).toBeNull();
    expect(page.entries.map((e) => [e.action, e.result, e.kind, e.title])).toEqual([
      ["something.new", "ok", "other", "something.new"],
      ["settings.spending", "ok", "settings", "Changed spending limits"],
      ["vault.decrypt", "denied", "secrets", "A saved key didn't open"],
      ["policy.override", "ok", "tools", "Changed a tool's setting"],
      ["approval.execute", "denied", "approvals", "Stopped an approved action at the last check"],
      ["approval.approve", "ok", "approvals", "Approved an action"],
      ["auth.login", "ok", "sign_in", "Signed in"],
    ]);
    const ids = page.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    // Details carry the raw record: JSON parsed, a plain string as it is.
    const byAction = (a: string) => page.entries.find((e) => e.action === a);
    expect(byAction("policy.override")?.detail).toEqual({
      from: "ask",
      to: "auto",
      riskClass: "egress",
    });
    expect(byAction("approval.approve")).toMatchObject({
      target: "b1/a1",
      detail: { tool: "send_email", scope: expect.stringContaining("send_email") },
    });
    expect(byAction("vault.decrypt")?.detail).toBe("model_key");
    expect(JSON.stringify(page)).not.toContain("u2-secret-marker");
  });

  it("filters by kind and refuses an unknown one", async () => {
    const { browser } = await seeded();
    const approvals = await read(browser, "?kind=approvals");
    expect(approvals.entries.map((e) => e.action)).toEqual([
      "approval.execute",
      "approval.approve",
    ]);
    expect((await read(browser, "?kind=exports")).entries).toEqual([]);
    expect((await browser.req("/api/activity/log?kind=nope")).status).toBe(400);
  });

  it("searches the raw text literally and the plain-language titles", async () => {
    const { browser } = await seeded();
    const actions = async (q: string) =>
      (await read(browser, `?q=${encodeURIComponent(q)}`)).entries.map((e) => e.action);
    expect(await actions("send_email")).toEqual(["policy.override", "approval.approve"]);
    expect(await actions("SIGNED IN")).toEqual(["auth.login"]);
    expect(await actions("last check")).toEqual(["approval.execute"]);
    // LIKE's wildcards are matched as typed.
    expect(await actions("100%")).toEqual(["something.new"]);
    expect(await actions("_")).toEqual([
      "vault.decrypt",
      "policy.override",
      "approval.execute",
      "approval.approve",
    ]);
    expect(await actions("u2-secret-marker")).toEqual([]);
    expect((await browser.req(`/api/activity/log?q=${"x".repeat(101)}`)).status).toBe(400);
  });

  it("pages by row ID until the end", async () => {
    const { browser } = await seeded();
    const first = await read(browser, "?limit=3");
    expect(first.entries).toHaveLength(3);
    const second = await read(browser, `?limit=3&before=${first.next}`);
    const third = await read(browser, `?limit=3&before=${second.next}`);
    expect(third.next).toBeNull();
    const all = [...first.entries, ...second.entries, ...third.entries].map((e) => e.id);
    expect(all).toEqual((await read(browser)).entries.map((e) => e.id));
    for (const bad of ["0", "-1", "x", "1.5"]) {
      expect((await browser.req(`/api/activity/log?before=${bad}`)).status).toBe(400);
    }
  });

  it("answers 401 without a session", async () => {
    await seeded();
    expect((await new Browser().req("/api/activity/log")).status).toBe(401);
  });
});
