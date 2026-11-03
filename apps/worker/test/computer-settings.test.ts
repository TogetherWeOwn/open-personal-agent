// SPDX-License-Identifier: Apache-2.0
// Settings › Computers, server side (M4-10 part a, AC1–AC2): provider entries, defaults, limits,
// Test. Route tests run against the empty deployment registry — no adapters are registered yet —
// so selection and Test resolve to 409s; the Test round trip itself is exercised through the
// port interface with the M4-01 fake, including the failure-destroys paths.
import {
  type ComputerProvider,
  ComputerProviderError,
  type ComputerSpec,
  createComputerSpec,
  createFakeComputerProvider,
} from "@opa/core";
import { stageExportItem } from "@opa/db/export";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { normalizeHost, runComputerTest } from "@opa/server/computer-settings";
import { describe, expect, it } from "vitest";
import { type Browser, claim, count, db, env, freshDatabase, type passkey } from "./helpers/app";

freshDatabase();

const get = (browser: Browser) => browser.req("/api/settings/computers");
const put = (browser: Browser, body: unknown) =>
  browser.req("/api/settings/computers", { method: "PUT", body });
const putAllowlist = (browser: Browser, body: unknown) =>
  browser.req("/api/settings/computers/allowlist", { method: "PUT", body });
const postTest = (browser: Browser, body?: unknown) =>
  browser.req("/api/settings/computers/test", { method: "POST", body });

async function stepUp(browser: Browser, key: ReturnType<typeof passkey>) {
  const res = await browser.req("/api/auth/step-up/session/options", { body: {} });
  const { options } = await res.json<{ options: { challenge: string } }>();
  return browser.req("/api/auth/step-up/session", {
    body: { credential: await key.get(options) },
  });
}

const auditRows = async (action: string) =>
  (
    await db
      .prepare("SELECT result, detail FROM audit_log WHERE action = ? ORDER BY id")
      .bind(action)
      .all<{ result: string; detail: string }>()
  ).results;

describe("computer settings", () => {
  it("reads the defaults for a fresh account", async () => {
    const { browser } = await claim();
    const res = await get(browser);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      defaultProvider: null,
      providers: [],
      defaults: { persistence: "ephemeral", sizeId: null },
      limits: { idleTimeoutMinutes: 5, maxLifetimeMinutes: 60 },
      internet: { allowed: false, hosts: [] },
    });
  });

  it("saves the scalars with an audit row", async () => {
    const { browser } = await claim();
    const res = await put(browser, {
      persistence: "persistent",
      sizeId: "standard-1",
      idleTimeoutMinutes: 10,
      maxLifetimeMinutes: 120,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      defaults: unknown;
      limits: unknown;
    }>();
    expect(body.defaults).toEqual({ persistence: "persistent", sizeId: "standard-1" });
    expect(body.limits).toEqual({ idleTimeoutMinutes: 10, maxLifetimeMinutes: 120 });
    const rows = await auditRows("settings.computer");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe("ok");
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      persistence: { from: "ephemeral", to: "persistent" },
      sizeId: { from: null, to: "standard-1" },
      idleTimeoutMinutes: { from: 5, to: 10 },
      maxLifetimeMinutes: { from: 60, to: 120 },
    });
  });

  it("requires the limits and rejects unknown providers", async () => {
    const { browser } = await claim();
    for (const [body, error, status] of [
      [{ idleTimeoutMinutes: 0 }, "invalid_idle_timeout", 400],
      [{ idleTimeoutMinutes: 121 }, "invalid_idle_timeout", 400],
      [{ idleTimeoutMinutes: 1.5 }, "invalid_idle_timeout", 400],
      [{ maxLifetimeMinutes: 0 }, "invalid_max_lifetime", 400],
      [{ idleTimeoutMinutes: 30, maxLifetimeMinutes: 10 }, "invalid_limits", 400],
      [{ persistence: "always-on" }, "invalid_persistence", 400],
      [{ sizeId: "" }, "invalid_size", 400],
      [{ defaultProvider: "sandbox" }, "unknown_provider", 409],
      [{ internetAllowed: "yes" }, "invalid_internet", 400],
    ] as const) {
      const res = await put(browser, body);
      expect([body, res.status, await res.json()]).toEqual([body, status, { error }]);
    }
    expect((await put(browser, [])).status).toBe(400);
    expect(await auditRows("settings.computer")).toHaveLength(0);
  });

  it("ignores unknown fields and skips the audit when nothing changed", async () => {
    const { browser } = await claim();
    const res = await put(browser, { futureField: true });
    expect(res.status).toBe(200);
    expect((await res.json<{ defaults: { persistence: unknown } }>()).defaults.persistence).toBe(
      "ephemeral",
    );
    expect(await auditRows("settings.computer")).toHaveLength(0);
  });

  it("needs the step-up to turn the on-off internet switch on", async () => {
    const { browser, key } = await claim();
    const refused = await put(browser, { internetAllowed: true });
    expect([refused.status, await refused.json()]).toEqual([403, { error: "step_up_required" }]);
    const denied = await auditRows("settings.computer");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.result).toBe("denied");
    expect((await stepUp(browser, key)).status).toBe(200);
    const allowed = await put(browser, { internetAllowed: true });
    expect(allowed.status).toBe(200);
    expect((await allowed.json<{ internet: { allowed: unknown } }>()).internet.allowed).toBe(true);
  });

  it("re-saving the internet switch when it is already on needs no step-up", async () => {
    const { browser, owner } = await claim();
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    await user.settings.saveComputer({ internetAllowed: true });
    const res = await put(browser, { internetAllowed: true });
    expect(res.status).toBe(200);
    expect((await res.json<{ internet: { allowed: unknown } }>()).internet.allowed).toBe(true);
    expect(await auditRows("settings.computer")).toHaveLength(0);
    const reread = await get(browser);
    expect((await reread.json<{ internet: { allowed: unknown } }>()).internet.allowed).toBe(true);
  });

  it("replaces the allowlist normalized, and rejects bad hosts", async () => {
    const { browser } = await claim();
    const res = await putAllowlist(browser, {
      hosts: ["PyPI.org.", "example.com", "EXAMPLE.com", "192.168.1.10"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hosts: ["192.168.1.10", "example.com", "pypi.org"] });
    const rows = await auditRows("settings.computer_allowlist");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({
      hosts: { from: [], to: ["192.168.1.10", "example.com", "pypi.org"] },
    });
    for (const hosts of [
      ["https://pypi.org/simple"],
      ["pypi.org:443"],
      ["*.pypi.org"],
      [""],
      ["not a host"],
    ]) {
      const bad = await putAllowlist(browser, { hosts });
      expect([hosts, bad.status, await bad.json()]).toEqual([
        hosts,
        400,
        { error: "invalid_host", host: hosts[0] },
      ]);
    }
    const cleared = await putAllowlist(browser, { hosts: [] });
    expect([cleared.status, await cleared.json()]).toEqual([200, { hosts: [] }]);
    expect((await putAllowlist(browser, { hosts: "pypi.org" })).status).toBe(400);
  });

  it("skips writes and audits for identical, reordered and normalized allowlists", async () => {
    const { browser } = await claim();
    expect((await putAllowlist(browser, { hosts: [] })).status).toBe(200);
    expect(await auditRows("settings.computer_allowlist")).toHaveLength(0);
    expect((await putAllowlist(browser, { hosts: ["example.com", "pypi.org"] })).status).toBe(200);
    // A rewrite would replace this timestamp, even if the host contents stayed identical.
    await db.prepare("UPDATE computer_egress_hosts SET created_at = 1").run();
    for (const hosts of [
      ["example.com", "pypi.org"],
      ["pypi.org", "example.com"],
      [" PyPI.ORG. ", "EXAMPLE.com", "example.com"],
    ]) {
      const response = await putAllowlist(browser, { hosts });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ hosts: ["example.com", "pypi.org"] });
    }
    expect(await auditRows("settings.computer_allowlist")).toHaveLength(1);
    const rows = await db.prepare("SELECT created_at FROM computer_egress_hosts").all();
    expect(rows.results).toEqual([{ created_at: 1 }, { created_at: 1 }]);
    expect((await putAllowlist(browser, { hosts: ["example.com"] })).status).toBe(200);
    expect((await putAllowlist(browser, { hosts: [] })).status).toBe(200);
    const audits = await auditRows("settings.computer_allowlist");
    expect(audits).toHaveLength(3);
    expect(JSON.parse(audits[1]?.detail ?? "{}")).toEqual({
      hosts: { from: ["example.com", "pypi.org"], to: ["example.com"] },
    });
    expect(JSON.parse(audits[2]?.detail ?? "{}")).toEqual({
      hosts: { from: ["example.com"], to: [] },
    });
  });

  it.each(["2001::db8::1", ":::", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "gggg::1"])(
    "rejects malformed IPv6 %s without persisting or auditing it",
    async (host) => {
      const { browser } = await claim();
      expect((await putAllowlist(browser, { hosts: [host] })).status).toBe(400);
      expect(await auditRows("settings.computer_allowlist")).toHaveLength(0);
      expect(await count("computer_egress_hosts")).toBe(0);
    },
  );

  it.each(["::", "::1", "2001:db8::1", "1:2:3:4:5:6:7:8", "::ffff:c000:280"])(
    "persists valid IPv6 %s",
    async (host) => {
      const { browser } = await claim();
      const response = await putAllowlist(browser, { hosts: [host] });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ hosts: [host] });
    },
  );

  it.each([false, true])("exports scoped computer settings (populated: %s)", async (populated) => {
    const { owner } = await claim();
    const repo = createRepository(env);
    const user = repo.forUser(scopeFromSession({ userId: owner }));
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('other', 'Other', 'member')")
      .run();
    const other = repo.forUser(scopeFromSession({ userId: "other" }));
    await other.settings.saveComputer({ defaultProvider: "other-provider", sizeId: "other-size" });
    await other.settings.saveEgressHosts(["other.example.com"]);
    if (populated) {
      await user.settings.saveComputer({
        defaultProvider: "test-provider",
        persistence: "persistent",
        sizeId: "custom-size",
        idleTimeoutSeconds: 600,
        maxLifetimeSeconds: 7200,
        internetAllowed: true,
      });
      await user.settings.saveEgressHosts(["example.com"]);
    }
    await stageExportItem(user, "computer-export", "settings");
    const files = await user.exports.listPrefix(user.exports.stagedPrefix("computer-export"));
    const contents = new Map<string, unknown>();
    for (const file of files) {
      const object = await user.exports.getObject(file.key);
      contents.set(file.key.split("/").at(-1) ?? "", await new Response(object?.body).json());
    }
    expect(contents.get("settings.json")).toEqual((await user.settings.get()) ?? null);
    expect(contents.get("computer_settings.json")).toEqual(await user.settings.computer());
    expect(JSON.stringify([...contents])).not.toContain("other-provider");
    expect(JSON.stringify([...contents])).not.toContain("other.example.com");
    expect(await other.exports.listPrefix(other.exports.stagedPrefix("computer-export"))).toEqual(
      [],
    );
  });

  it("caps the allowlist", async () => {
    const { browser } = await claim();
    const hosts = Array.from({ length: 201 }, (_, i) => `host${i}.example.com`);
    const res = await putAllowlist(browser, { hosts });
    expect([res.status, await res.json()]).toEqual([400, { error: "too_many_hosts", max: 200 }]);
  });

  it("answers Test 409 with no providers registered", async () => {
    const { browser } = await claim();
    const none = await postTest(browser, {});
    expect([none.status, await none.json()]).toEqual([409, { error: "no_provider" }]);
    const unknown = await postTest(browser, { provider: "sandbox" });
    expect([unknown.status, await unknown.json()]).toEqual([409, { error: "unknown_provider" }]);
    const invalid = await postTest(browser, { provider: 5 });
    expect([invalid.status, await invalid.json()]).toEqual([400, { error: "invalid_provider" }]);
  });

  it("stores the task override and shows it on the task", async () => {
    const { browser, owner } = await claim();
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    await user.createConversation("cc", "chat");
    await user.tasks.create({
      id: "xt1",
      conversationId: "cc",
      kind: "turn",
      mode: "background",
    });
    const cleared = await browser.req("/api/tasks/xt1/computer", {
      method: "PUT",
      body: { provider: null },
    });
    expect([cleared.status, await cleared.json()]).toEqual([200, { computerProvider: null }]);
    const unknown = await browser.req("/api/tasks/xt1/computer", {
      method: "PUT",
      body: { provider: "sandbox" },
    });
    expect([unknown.status, await unknown.json()]).toEqual([409, { error: "unknown_provider" }]);
    const missing = await browser.req("/api/tasks/xt1/computer", { method: "PUT", body: {} });
    expect([missing.status, await missing.json()]).toEqual([400, { error: "invalid_body" }]);
    const task = await browser.req("/api/tasks/xt1");
    expect(
      ((await task.json()) as { task: { computerProvider: unknown } }).task.computerProvider,
    ).toBe(null);
    expect(await count("audit_log", "action = 'tasks.computer'")).toBe(0);
  });
});

describe("normalizeHost", () => {
  it.each([
    ["PyPI.Org.", "pypi.org"],
    ["  example.com  ", "example.com"],
    ["192.168.1.10", "192.168.1.10"],
    ["host.docker.internal", "host.docker.internal"],
    ["2001:0DB8:0000:0000:0000:0000:0000:0001", "2001:db8::1"],
    ["::ffff:192.0.2.128", "::ffff:c000:280"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
  it.each([
    ["https://pypi.org"],
    ["pypi.org/path"],
    ["*.pypi.org"],
    [""],
    ["a".repeat(254)],
    [5],
    ["[::1]"],
    ["::1."],
    ["fe80::1%eth0"],
    ["::ffff:192.0.2.999"],
  ])("rejects %j", (input) => {
    expect(normalizeHost(input)).toBe(null);
  });
});

describe("runComputerTest", () => {
  const spec = (): ComputerSpec =>
    createComputerSpec({
      profile: "standard",
      idleTimeoutSeconds: 300,
      maxLifetimeSeconds: 3600,
    });

  it("runs the echo/file round trip and destroys the computer", async () => {
    const provider = createFakeComputerProvider();
    const report = await runComputerTest(provider, spec());
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.provider).toBe("fake");
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.echo).toBe("ok");
    expect(report.files).toBe("ok");
    expect(report.capabilities).toEqual(provider.capabilities());
    expect(report.price).toBe(null);
    expect(report.destroyed).toBe(true);
    expect(await provider.list()).toEqual([]);
  });

  it("destroys the computer when exec fails", async () => {
    const inner = createFakeComputerProvider();
    const provider: ComputerProvider = {
      ...inner,
      exec: () => {
        throw new ComputerProviderError("boom", "provider");
      },
    };
    const report = await runComputerTest(provider, spec());
    expect(report).toMatchObject({ ok: false, destroyed: true });
    if (report.ok) return;
    expect(report.error.code).toBe("provider");
    expect(await inner.list()).toEqual([]);
  });

  it("destroys the computer on a non-zero exit", async () => {
    const inner = createFakeComputerProvider();
    const provider: ComputerProvider = {
      ...inner,
      async *exec() {
        yield { type: "exit" as const, code: 1 };
      },
    };
    const report = await runComputerTest(provider, spec());
    expect(report).toMatchObject({ ok: false, destroyed: true });
    expect(await inner.list()).toEqual([]);
  });

  it("destroys the computer when the file round trip changes bytes", async () => {
    const inner = createFakeComputerProvider();
    const provider: ComputerProvider = {
      ...inner,
      getFile: async () => new TextEncoder().encode("tampered"),
    };
    const report = await runComputerTest(provider, spec());
    expect(report).toMatchObject({ ok: false, destroyed: true });
    expect(await inner.list()).toEqual([]);
  });

  it("reports a create failure with nothing to destroy", async () => {
    const provider: ComputerProvider = {
      ...createFakeComputerProvider(),
      create: async () => {
        throw new ComputerProviderError("nope", "provider");
      },
    };
    const report = await runComputerTest(provider, spec());
    expect(report).toEqual({
      ok: false,
      error: { code: "provider", message: "nope" },
      destroyed: false,
    });
  });

  it("reports a failed destroy honestly", async () => {
    const provider: ComputerProvider = {
      ...createFakeComputerProvider(),
      destroy: async () => {
        throw new ComputerProviderError("stuck", "provider");
      },
    };
    const report = await runComputerTest(provider, spec());
    expect(report).toMatchObject({ ok: true, destroyed: false });
  });

  it("times out a create that never settles", async () => {
    const provider: ComputerProvider = {
      ...createFakeComputerProvider(),
      create: () => new Promise(() => {}),
    };
    const report = await runComputerTest(provider, spec(), { timeoutMs: 5 });
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.error.code).toBe("timeout");
    expect(report.destroyed).toBe(false);
  });

  it("destroys a create that lands after the timeout", async () => {
    const inner = createFakeComputerProvider();
    const provider: ComputerProvider = {
      ...inner,
      create: async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return inner.create(...args);
      },
    };
    const report = await runComputerTest(provider, spec(), { timeoutMs: 5 });
    expect(report.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await inner.list()).toEqual([]);
  });

  it("bounds stalled exec and iterator cancellation, then destroys the computer", async () => {
    const inner = createFakeComputerProvider();
    let cancelled = false;
    const provider: ComputerProvider = {
      ...inner,
      exec: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: () => {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      }),
    };
    const report = await Promise.race([
      runComputerTest(provider, spec(), { timeoutMs: 5 }),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 200)),
    ]);
    expect(report).toMatchObject({ ok: false, error: { code: "timeout" }, destroyed: true });
    expect(cancelled).toBe(true);
    expect(await inner.list()).toEqual([]);
  });

  it.each([false, true])("bounds stalled destroy after exec failure: %s", async (execFails) => {
    const inner = createFakeComputerProvider();
    let attempts = 0;
    const provider: ComputerProvider = {
      ...inner,
      ...(execFails
        ? {
            exec: () => {
              throw new ComputerProviderError("boom", "provider");
            },
          }
        : {}),
      destroy: () => {
        attempts += 1;
        return new Promise(() => {});
      },
    };
    try {
      const report = await Promise.race([
        runComputerTest(provider, spec(), { timeoutMs: 5 }),
        new Promise((resolve) => setTimeout(() => resolve("still pending"), 200)),
      ]);
      expect(report).toMatchObject({ ok: !execFails, destroyed: false });
      expect(attempts).toBe(1);
      expect(await inner.list()).toHaveLength(1);
    } finally {
      for (const handle of await inner.list()) await inner.destroy(handle);
    }
  });

  it("maps a hand-rolled spec failure to its port code", async () => {
    const provider = createFakeComputerProvider();
    const report = await runComputerTest(provider, {
      profile: "standard",
      idleTimeoutSeconds: 0,
      maxLifetimeSeconds: 3600,
    });
    expect(report).toMatchObject({ ok: false, destroyed: false });
    if (report.ok) return;
    expect(report.error.code).toBe("invalid_spec");
  });
});
