// SPDX-License-Identifier: Apache-2.0
// Settings › Computers, server side (M4-10 part a, AC1–AC2): provider entries, defaults, limits,
// Test. Provider entries are settings, not deploys: the default provider, the per-task override
// (PUT on the task route below) and the persistence/size/timeout defaults are D1 values the live
// registry resolves — switching provider moves no data and redeploys nothing (M4-01 AC5). The
// idle timeout (default 5 min) and max lifetime (default 1 h) are required fields the API speaks
// in minutes, stored in the port's seconds. Internet is off by default: an empty allowlist for
// allowlist providers, and the on-off switch defaulting off where a provider supports only that.
//
// Allowlist edits are accepted only from an authenticated, untainted settings action — never from
// a model or tool call. The enforcement is structural: these routes sit behind the session guard
// (a cookie session no model or tool call carries — capability tokens never substitute for it),
// and no tool writes these stores (the tools manifest carries no settings-writing tool; the
// `task` tool is not offered at all). Turning the on-off switch on additionally needs the
// 5-minute account step-up, like the other loosening settings changes; allowlist adds and
// removals are plain saves of user-typed hostnames, as `m4-ux` §2.6 specifies.
//
// Test (PRD §4.1, AC2) creates a real computer through the port interface, runs an `echo`/file
// round trip, and reports latency, the provider's declared capabilities and the dated price hint
// — then destroys the computer, including on failure. The probe writes no D1 rows: it is not a
// lifecycle computer, so it stays out of the owner records and the COST-9 ledger, which keep
// one row per session for real borrows. The price hint is `null` until M4-15 lands the computer
// COST-7/8 entries: the route reports no price rather than invent one without a `verifiedAt`.
import {
  assertComputerSpec,
  type ComputerCapabilities,
  type ComputerHandle,
  type ComputerProvider,
  ComputerProviderError,
  type ComputerSpec,
  createComputerProviderRegistry,
  type ExecEvent,
} from "@opa/core";
import {
  type ComputerSettings,
  type ComputerSettingsUpdate,
  createRepository,
} from "@opa/db/repository";
import { log } from "@opa/log";
import { type Context, Hono } from "hono";
import { changes } from "./audit";
import type { AppEnv } from "./env";
import { hasAccountStepUp } from "./session";

type Ctx = Context<AppEnv>;

const userOf = (c: Ctx) => createRepository(c.env).forUser(c.var.session.scope);
const storeOf = (c: Ctx) => userOf(c).settings;

const TEST_TIMEOUT_MS = 60_000;
const TEST_MARKER = "opa-computer-test";
const TEST_FILE = "opa-computer-test.txt";
const MAX_PROVIDER_LENGTH = 128;
const MAX_SIZE_LENGTH = 64;
const MAX_HOSTS = 200;
const MAX_IDLE_MINUTES = 120;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;

/**
 * The deployment's computer providers (M4-01 AC5): the registry the settings default resolves
 * against. Empty until the adapter cards register here — M4-04 (Cloudflare Sandbox) and M4-05
 * (docker-local) from their runtime bindings, M4-06 (ssh-vm) with its vault-bound credential.
 * Registration validates every provider's ADR 0007 #2 declarations and rejects duplicate ids.
 */
export function computerProviders(): ComputerProvider[] {
  return [];
}

const registry = () => createComputerProviderRegistry(computerProviders());

/**
 * Resolves a provider id against the live registry for the settings default and the per-task
 * override. Throws `ComputerProviderError`: the callers answer 409, never 500, for an id no
 * registered provider claims — selecting vapor is refused, not stored.
 */
export function resolveComputerProvider(id: string): ComputerProvider {
  return registry().resolveDefault(id);
}

/** The Test report (AC2): the round trip, latency, declarations, price hint and cleanup proof. */
export type ComputerTestReport =
  | {
      ok: true;
      provider: string;
      latencyMs: number;
      echo: "ok";
      files: "ok";
      capabilities: ComputerCapabilities;
      /** Null until M4-15 prices computer sessions (COST-7/8): no invented `verifiedAt`. */
      price: null;
      destroyed: boolean;
    }
  | { ok: false; error: { code: string; message: string }; destroyed: boolean };

/** A Test step that outlived its deadline; reported as `timeout`, never a provider code. */
class TestTimeout extends Error {
  readonly code = "timeout";
}

const timeout = (ms: number, what: string): Promise<never> =>
  new Promise((_, reject) => {
    setTimeout(() => reject(new TestTimeout(`${what} timed out after ${ms / 1000} seconds`)), ms);
  });

const withTimeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([work, timeout(ms, what)]);

/** Provider errors cross to the browser truncated: adapters must keep secrets out of them. */
const safeError = (error: unknown): { code: string; message: string } => {
  if (error instanceof ComputerProviderError) {
    return { code: error.code, message: error.message.slice(0, 300) };
  }
  if (error instanceof TestTimeout) return { code: error.code, message: error.message };
  return { code: "provider", message: "The computer provider failed the test." };
};

/** Drains one exec stream: the stdout, throwing on the terminal error or a non-zero exit. */
async function collectExec(events: AsyncIterable<ExecEvent>, argv: string[]): Promise<string> {
  let stdout = "";
  for await (const event of events) {
    if (event.type === "stdout") stdout += event.text;
    else if (event.type === "error") {
      throw new ComputerProviderError(`echo failed: ${event.message.slice(0, 300)}`, event.code);
    } else if (event.type === "exit" && event.code !== 0) {
      throw new ComputerProviderError(
        `echo exited with code ${event.code} (argv ${argv.join(" ")})`,
        "provider",
      );
    }
  }
  return stdout;
}

/**
 * The axis Test action (AC2): create, `echo`/file round trip, report, destroy. A failed Test
 * destroys whatever it created before reporting — nothing is left running. Destroys are
 * best-effort with the failure recorded on the report: a destroy that itself fails is reported
 * honestly (`destroyed: false`) rather than claimed. A create that outlives the timeout is
 * destroyed late when it lands; a create that never settles is the sweep's orphan leg to reap
 * once a provider driver is wired into it (M4-02 AC3).
 */
export async function runComputerTest(
  provider: ComputerProvider,
  spec: ComputerSpec,
  opts: { timeoutMs?: number } = {},
): Promise<ComputerTestReport> {
  const timeoutMs = opts.timeoutMs ?? TEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  let handle: ComputerHandle | null = null;
  let destroyed = false;
  const destroy = async () => {
    if (!handle) return;
    try {
      await provider.destroy(handle);
      destroyed = true;
    } catch (error) {
      log.error("computer-settings.test.cleanup", {
        errorName: (error as Error)?.name ?? "error",
      });
    }
  };
  try {
    const started = Date.now();
    const created = provider.create(spec);
    try {
      handle = await withTimeout(created, timeoutMs, "Creating the test computer");
    } catch (error) {
      // The create may still land after the timeout: destroy it late instead of leaking a
      // billing computer no D1 row names.
      void created.then(
        async (late) => {
          handle = late;
          await destroy();
        },
        () => {},
      );
      throw error;
    }
    const latencyMs = Date.now() - started;
    const stdout = await collectExec(
      provider.exec(handle, { argv: ["echo", TEST_MARKER], signal }),
      ["echo", TEST_MARKER],
    );
    if (!stdout.includes(TEST_MARKER)) {
      throw new ComputerProviderError("echo did not return the test marker", "provider");
    }
    const data = new TextEncoder().encode(TEST_MARKER);
    await withTimeout(provider.putFile(handle, TEST_FILE, data), timeoutMs, "Writing");
    const back = await withTimeout(provider.getFile(handle, TEST_FILE), timeoutMs, "Reading");
    if (back.length !== data.length || !back.every((byte, i) => byte === data[i])) {
      throw new ComputerProviderError("the file round trip changed the bytes", "provider");
    }
    const capabilities = provider.capabilities();
    await destroy();
    return {
      ok: true,
      provider: provider.id,
      latencyMs,
      echo: "ok",
      files: "ok",
      capabilities,
      price: null,
      destroyed,
    };
  } catch (error) {
    await destroy();
    return { ok: false, error: safeError(error), destroyed };
  }
}

interface ProviderView {
  id: string;
  available: true;
  capabilities: ComputerCapabilities;
  /** Null until M4-15 prices computer sessions (COST-7/8). */
  price: null;
}

const providerView = (provider: ComputerProvider): ProviderView => ({
  id: provider.id,
  available: true,
  capabilities: provider.capabilities(),
  price: null,
});

const view = (settings: ComputerSettings, providers: ProviderView[]) => ({
  defaultProvider: settings.defaultProvider,
  providers,
  defaults: { persistence: settings.persistence, sizeId: settings.sizeId },
  limits: {
    idleTimeoutMinutes: settings.idleTimeoutSeconds / 60,
    maxLifetimeMinutes: settings.maxLifetimeSeconds / 60,
  },
  internet: { allowed: settings.internetAllowed, hosts: settings.egressHosts },
});

const fail = (c: Ctx, status: 400 | 403 | 409, error: string) => c.json({ error }, status);

export const computerSettings = new Hono<AppEnv>();

computerSettings.use(async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});

computerSettings.get("/", async (c) => {
  const settings = await storeOf(c).computer();
  return c.json(view(settings, computerProviders().map(providerView)));
});

const minutes = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** Body: any subset of the scalars; absent fields stay as they are. */
computerSettings.put("/", async (c) => {
  const store = storeOf(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(c, 400, "invalid_body");
  }
  const settings = await store.computer();
  const before = {
    defaultProvider: settings.defaultProvider,
    persistence: settings.persistence,
    sizeId: settings.sizeId,
    idleTimeoutMinutes: settings.idleTimeoutSeconds / 60,
    maxLifetimeMinutes: settings.maxLifetimeSeconds / 60,
    internetAllowed: settings.internetAllowed,
  };
  const after = { ...before };
  if (body.defaultProvider !== undefined) {
    const id =
      body.defaultProvider === null ? null : text(body.defaultProvider, MAX_PROVIDER_LENGTH);
    if (body.defaultProvider !== null && id === null) return fail(c, 400, "invalid_provider");
    if (id !== null) {
      try {
        resolveComputerProvider(id);
      } catch {
        return fail(c, 409, "unknown_provider");
      }
    }
    after.defaultProvider = id;
  }
  if (body.persistence !== undefined) {
    if (body.persistence !== "ephemeral" && body.persistence !== "persistent") {
      return fail(c, 400, "invalid_persistence");
    }
    after.persistence = body.persistence;
  }
  if (body.sizeId !== undefined) {
    const sizeId = body.sizeId === null ? null : text(body.sizeId, MAX_SIZE_LENGTH);
    if (body.sizeId !== null && sizeId === null) return fail(c, 400, "invalid_size");
    after.sizeId = sizeId;
  }
  const idle =
    body.idleTimeoutMinutes === undefined
      ? before.idleTimeoutMinutes
      : minutes(body.idleTimeoutMinutes);
  const lifetime =
    body.maxLifetimeMinutes === undefined
      ? before.maxLifetimeMinutes
      : minutes(body.maxLifetimeMinutes);
  if (idle === null || idle < 1 || idle > MAX_IDLE_MINUTES) {
    return fail(c, 400, "invalid_idle_timeout");
  }
  if (lifetime === null || lifetime < 1) return fail(c, 400, "invalid_max_lifetime");
  after.idleTimeoutMinutes = idle;
  after.maxLifetimeMinutes = lifetime;
  try {
    // The port owns the ceiling and the idle-≤-lifetime rule (M4-01 AC2): one source of truth.
    assertComputerSpec({
      profile: "standard",
      idleTimeoutSeconds: idle * 60,
      maxLifetimeSeconds: lifetime * 60,
    });
  } catch {
    return fail(c, 400, "invalid_limits");
  }
  if (body.internetAllowed !== undefined) {
    if (typeof body.internetAllowed !== "boolean") return fail(c, 400, "invalid_internet");
    if (body.internetAllowed && !before.internetAllowed && !hasAccountStepUp(c.var.session)) {
      // Turning the on-off switch on loosens egress: step-up or refuse, audited as denied. A
      // no-op re-save of an already-on switch is not a transition and needs no step-up.
      await store.saveComputer(
        {},
        {
          action: "settings.computer",
          module: "settings",
          result: "denied",
          detail: { internetAllowed: { from: before.internetAllowed, to: true } },
        },
      );
      return c.json({ error: "step_up_required" }, 403);
    }
    after.internetAllowed = body.internetAllowed;
  }
  const detail = changes(before, after);
  if (!detail) return c.json(view(settings, computerProviders().map(providerView)));
  const to: ComputerSettingsUpdate = {
    defaultProvider: after.defaultProvider,
    persistence: after.persistence,
    sizeId: after.sizeId,
    idleTimeoutSeconds: after.idleTimeoutMinutes * 60,
    maxLifetimeSeconds: after.maxLifetimeMinutes * 60,
    internetAllowed: after.internetAllowed,
  };
  await store.saveComputer(to, { action: "settings.computer", module: "settings", detail });
  return c.json(view({ ...settings, ...to }, computerProviders().map(providerView)));
});

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^([0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;
const DNS =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])$/;

/** Lowercases and validates one allowlist entry: a DNS name or IP literal, never a URL. */
export function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase().replace(/\.+$/, "");
  if (host === "" || host.length > 253) return null;
  if (IPV4.test(host) || IPV6.test(host)) return host;
  return DNS.test(host) ? host : null;
}

/** Body `{ hosts: string[] }`: replaces the whole allowlist, empty meaning no egress. */
computerSettings.put("/allowlist", async (c) => {
  const store = storeOf(c);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray(body.hosts)) {
    return fail(c, 400, "invalid_allowlist");
  }
  const hosts: string[] = [];
  for (const entry of body.hosts) {
    const host = normalizeHost(entry);
    if (!host) return c.json({ error: "invalid_host", host: String(entry).slice(0, 100) }, 400);
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length > MAX_HOSTS) return c.json({ error: "too_many_hosts", max: MAX_HOSTS }, 400);
  hosts.sort();
  const settings = await store.computer();
  const detail = changes({ hosts: settings.egressHosts }, { hosts });
  if (detail) {
    await store.saveEgressHosts(hosts, {
      action: "settings.computer_allowlist",
      module: "settings",
      detail,
    });
  }
  return c.json({ hosts });
});

/**
 * Tests a provider (AC2): the body's provider, else the Settings default, else the sole
 * registered provider. With no providers registered — before M4-04/05 land — there is nothing
 * to test: 409, never an invented success.
 */
computerSettings.post("/test", async (c) => {
  const store = storeOf(c);
  const body = await c.req.json().catch(() => null);
  const bodyProvider =
    body?.provider === undefined ? undefined : text(body.provider, MAX_PROVIDER_LENGTH);
  if (bodyProvider === null) return fail(c, 400, "invalid_provider");
  const settings = await store.computer();
  const wanted = bodyProvider ?? settings.defaultProvider ?? undefined;
  let provider: ComputerProvider;
  try {
    provider = registry().resolveDefault(wanted);
  } catch {
    return fail(c, 409, wanted === undefined ? "no_provider" : "unknown_provider");
  }
  const capabilities = provider.capabilities();
  const spec = {
    profile: "standard" as const,
    idleTimeoutSeconds: settings.idleTimeoutSeconds,
    maxLifetimeSeconds: settings.maxLifetimeSeconds,
    ...(settings.sizeId ? { sizeId: settings.sizeId } : {}),
    ...(capabilities.egressControl === "allowlist" ? { egressHosts: settings.egressHosts } : {}),
  };
  return c.json(await runComputerTest(provider, spec));
});
