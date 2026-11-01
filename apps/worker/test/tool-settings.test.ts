// SPDX-License-Identifier: Apache-2.0
// Per-tool overrides, the account step-up and standing grants (M3-02 AC2, AC7).
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { type TaintState, type ToolManifest, TRUSTED } from "@opa/policy";
import { beforeAll, describe, expect, it } from "vitest";
import { CHALLENGE_COOKIE, STEP_UP_MS } from "../src/auth";
import { builtinTools } from "../src/tools";
import { Browser, claim, count, db, env, freshDatabase, passkey } from "./helpers/app";

freshDatabase();

type Options = { options: { challenge: string; allowCredentials?: { id: string }[] } };
type Tool = { name: string; riskClass: string; override: string | null; locked: boolean };

const tool = (name: string, riskClass: ToolManifest["riskClass"]) => ({
  manifest: {
    name,
    description: `A ${riskClass} test tool.`,
    inputSchema: { type: "object" as const },
    riskClass,
    destinations: [],
    scopes: [],
  },
});

beforeAll(() => {
  // The registry is module state: register once, however often the file's suites run.
  for (const t of [tool("probe_send", "consequential"), tool("probe_delete", "irreversible")])
    if (!builtinTools.get(t.manifest.name)) builtinTools.register(t);
});

const setOverride = (br: Browser, name: string, override: unknown) =>
  br.req(`/api/settings/tools/${name}`, { method: "PUT", body: { override } });

async function stepUp(br: Browser, key: ReturnType<typeof passkey>) {
  const res = await br.req("/api/auth/step-up/options", { body: {} });
  const { options } = await res.json<Options>();
  return br.req("/api/auth/step-up", { body: { credential: await key.get(options) } });
}

const overrideAudit = async () =>
  (
    await db
      .prepare(
        "SELECT result, target_id, detail FROM audit_log WHERE action = 'policy.override' ORDER BY id",
      )
      .all<{ result: string; target_id: string; detail: string }>()
  ).results.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

describe("tool overrides", () => {
  it("lists each tool with its risk class, override and floor lock", async () => {
    const { browser } = await claim();
    const { tools } = await (await browser.req("/api/settings/tools")).json<{ tools: Tool[] }>();
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "probe_send",
          riskClass: "consequential",
          override: null,
          locked: false,
        }),
        expect.objectContaining({ name: "probe_delete", override: null, locked: true }),
      ]),
    );
  });

  it("tightens without a step-up and audits both values and the risk class", async () => {
    const { browser } = await claim();
    expect((await setOverride(browser, "probe_send", "never")).status).toBe(200);
    expect(await overrideAudit()).toEqual([
      {
        result: "ok",
        target_id: "probe_send",
        detail: { tool: "probe_send", from: null, to: "never", riskClass: "consequential" },
      },
    ]);
    // Unchanged: nothing to write.
    expect((await setOverride(browser, "probe_send", "never")).status).toBe(200);
    expect(await count("audit_log", "action = 'policy.override'")).toBe(1);
  });

  it("refuses a loosening without a step-up, and audits the refusal", async () => {
    const { browser } = await claim();
    await setOverride(browser, "probe_send", "never");
    for (const to of ["ask", null, "auto"]) {
      const res = await setOverride(browser, "probe_send", to);
      expect([to, res.status, await res.json()]).toEqual([to, 403, { error: "step_up_required" }]);
    }
    expect(await db.prepare("SELECT decision FROM tool_overrides").first("decision")).toBe("never");
    expect((await overrideAudit()).map((r) => r.result)).toEqual([
      "ok",
      "denied",
      "denied",
      "denied",
    ]);
  });

  it("loosens within 5 minutes of a step-up in this session only", async () => {
    const { browser, key } = await claim();
    const other = new Browser();
    expect((await other.login(key)).status).toBe(200);

    expect((await stepUp(browser, key)).status).toBe(200);
    expect(await count("audit_log", "action = 'auth.step_up' AND result = 'ok'")).toBe(1);
    const res = await setOverride(browser, "probe_send", "auto");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "probe_send", override: "auto" });
    expect((await overrideAudit()).at(-1)).toEqual({
      result: "ok",
      target_id: "probe_send",
      detail: { tool: "probe_send", from: null, to: "auto", riskClass: "consequential" },
    });

    // Another session of the same user hasn't stepped up.
    await setOverride(other, "probe_send", "never");
    expect((await setOverride(other, "probe_send", "ask")).status).toBe(403);

    // The window is 5 minutes.
    await db
      .prepare("UPDATE sessions SET step_up_at = ?")
      .bind(Date.now() - STEP_UP_MS)
      .run();
    expect((await setOverride(browser, "probe_send", "ask")).status).toBe(403);
  });

  it("keeps an irreversible tool from auto, and rejects bad input", async () => {
    const { browser, key } = await claim();
    await stepUp(browser, key);
    const locked = await setOverride(browser, "probe_delete", "auto");
    expect([locked.status, await locked.json()]).toEqual([400, { error: "floor_irreversible" }]);
    expect((await setOverride(browser, "probe_delete", "never")).status).toBe(200);
    expect((await setOverride(browser, "probe_send", "yes")).status).toBe(400);
    expect((await setOverride(browser, "probe_send", undefined)).status).toBe(400);
    expect((await setOverride(browser, "no_such_tool", "never")).status).toBe(404);
  });
});

describe("account step-up", () => {
  it("offers only the user's own passkeys and uses a challenge once", async () => {
    const { browser, key } = await claim();
    const res = await browser.req("/api/auth/step-up/options", { body: {} });
    const { options } = await res.json<Options>();
    const own = await db.prepare("SELECT id FROM passkeys").first<string>("id");
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([own]);
    const challenge = browser.cookies.get(CHALLENGE_COOKIE) as string;
    const credential = await key.get(options);
    expect((await browser.req("/api/auth/step-up", { body: { credential } })).status).toBe(200);
    browser.cookies.set(CHALLENGE_COOKIE, challenge);
    const replay = await browser.req("/api/auth/step-up", { body: { credential } });
    expect([replay.status, await replay.json()]).toEqual([400, { error: "no_challenge" }]);
  });

  it("refuses a login challenge, a stranger's passkey and a missing UV flag", async () => {
    const { browser, key } = await claim();
    // A login challenge can't stand in for a step-up.
    const login = await browser.req("/api/auth/login/options", { body: {} });
    const { options: loginOptions } = await login.json<Options>();
    const credential = await key.get(loginOptions);
    expect((await browser.req("/api/auth/step-up", { body: { credential } })).status).toBe(400);

    const stranger = passkey();
    await stranger.create({ challenge: "x" });
    const res = await browser.req("/api/auth/step-up/options", { body: {} });
    const { options } = await res.json<Options>();
    const foreign = await stranger.get(options);
    expect((await browser.req("/api/auth/step-up", { body: { credential: foreign } })).status).toBe(
      401,
    );

    await browser.req("/api/auth/step-up/options", { body: {} }).then(async (r) => {
      const { options: again } = await r.json<Options>();
      const noUv = await key.get(again, { uv: false });
      expect((await browser.req("/api/auth/step-up", { body: { credential: noUv } })).status).toBe(
        401,
      );
    });
    expect(await count("sessions", "step_up_at IS NOT NULL")).toBe(0);
    expect(await count("audit_log", "action = 'auth.step_up' AND result = 'denied'")).toBe(3);
  });
});

describe("standing grants", () => {
  const tainted: TaintState = { taint: "untrusted", sources: [{ kind: "web", label: "x" }] };

  it("are created only from an untainted context, listed while live, and revocable", async () => {
    const { browser, owner } = await claim();
    const policy = createRepository(env).forUser(scopeFromSession({ userId: owner })).policy;
    const always = { tool: "probe_send", scope: "destination", destination: "a.test" } as const;
    await expect(policy.grant(always, tainted)).rejects.toThrow(/tainted/);
    const id = await policy.grant(always, TRUSTED);
    await policy.grant({ tool: "probe_send", scope: "hour", expiresAt: Date.now() - 1 }, TRUSTED);

    const list = await (await browser.req("/api/settings/grants")).json<{ grants: unknown[] }>();
    expect(list.grants).toEqual([expect.objectContaining({ id, ...always })]);
    expect(await policy.grants(Date.now(), "other_tool")).toEqual([]);

    const revoke = () => browser.req(`/api/settings/grants/${id}`, { method: "DELETE" });
    expect((await revoke()).status).toBe(204);
    expect((await revoke()).status).toBe(404);
    expect(await policy.grants(Date.now())).toEqual([]);
    expect(await count("audit_log", "action = 'policy.grant' AND result = 'ok'")).toBe(2);
    expect(await count("audit_log", "action = 'policy.revoke' AND result = 'ok'")).toBe(1);
  });

  it("never lists or revokes another user's grant", async () => {
    const { browser } = await claim();
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('bob', 'B', 'member')")
      .run();
    const bob = createRepository(env).forUser(scopeFromSession({ userId: "bob" })).policy;
    const id = await bob.grant({ tool: "probe_send", scope: "task", taskId: "t1" }, TRUSTED);
    const list = await (await browser.req("/api/settings/grants")).json<{ grants: unknown[] }>();
    expect(list.grants).toEqual([]);
    expect((await browser.req(`/api/settings/grants/${id}`, { method: "DELETE" })).status).toBe(
      404,
    );
    expect(await bob.grants(Date.now())).toHaveLength(1);
  });

  it("rejects a grant row without its scope's target", async () => {
    const { owner } = await claim();
    const policy = createRepository(env).forUser(scopeFromSession({ userId: owner })).policy;
    await expect(policy.grant({ tool: "probe_send", scope: "task" }, TRUSTED)).rejects.toThrow();
  });
});
