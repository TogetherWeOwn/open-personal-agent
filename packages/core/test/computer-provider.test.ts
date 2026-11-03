// SPDX-License-Identifier: Apache-2.0
// M4-01 coverage: spec construction (AC2), registration failure modes (AC3), default switching
// (AC5), and the conformance suite against the fake (AC4).
import { describe, expect, it } from "vitest";
import { checkComputerProvider } from "../src/computer-conformance";
import {
  assertComputerCapabilities,
  assertComputerSpec,
  type ComputerCapabilities,
  type ComputerProvider,
  ComputerProviderError,
  type ComputerProviderErrorCode,
  createComputerProviderRegistry,
  createComputerSpec,
} from "../src/computer-provider";
import { createFakeComputerProvider } from "../src/fake-computer-provider";

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: ComputerProviderErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerProviderError);
    expect((error as ComputerProviderError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code "${code}", call succeeded`);
}

function providerWith(id: string, capabilities: unknown): ComputerProvider {
  const fake = createFakeComputerProvider({ id });
  return { ...fake, capabilities: () => capabilities as ComputerCapabilities };
}

describe("createComputerSpec", () => {
  it("applies the idle-300 / lifetime-3600 defaults (AC2)", () => {
    expect(createComputerSpec({ profile: "standard" })).toEqual({
      profile: "standard",
      idleTimeoutSeconds: 300,
      maxLifetimeSeconds: 3600,
    });
  });

  it("keeps explicit timeouts, size and egress hosts", () => {
    expect(
      createComputerSpec({
        profile: "persistent",
        idleTimeoutSeconds: 60,
        maxLifetimeSeconds: 600,
        sizeId: "standard-1",
        egressHosts: ["example.com"],
      }),
    ).toEqual({
      profile: "persistent",
      idleTimeoutSeconds: 60,
      maxLifetimeSeconds: 600,
      sizeId: "standard-1",
      egressHosts: ["example.com"],
    });
  });

  it("rejects invalid or missing values (AC2)", () => {
    const bad: unknown[] = [
      {},
      { profile: "nope" },
      { profile: "standard", idleTimeoutSeconds: 0 },
      { profile: "standard", idleTimeoutSeconds: -5 },
      { profile: "standard", idleTimeoutSeconds: 1.5 },
      { profile: "standard", idleTimeoutSeconds: Number.NaN },
      { profile: "standard", idleTimeoutSeconds: Number.POSITIVE_INFINITY },
      { profile: "standard", maxLifetimeSeconds: 0 },
      { profile: "standard", maxLifetimeSeconds: -1 },
      { profile: "standard", idleTimeoutSeconds: 9999, maxLifetimeSeconds: 60 },
      { profile: "standard", sizeId: "" },
      { profile: "standard", egressHosts: [""] },
      { profile: "standard", egressHosts: "example.com" },
      // Deadline arithmetic must stay inside the Date range: no unsafe integers, no huge values.
      { profile: "standard", idleTimeoutSeconds: 1e300, maxLifetimeSeconds: 1e300 },
      { profile: "standard", idleTimeoutSeconds: 300, maxLifetimeSeconds: 1e300 },
      {
        profile: "standard",
        idleTimeoutSeconds: 300,
        maxLifetimeSeconds: 365 * 24 * 3600 + 1,
      },
      {
        profile: "standard",
        idleTimeoutSeconds: Number.MAX_SAFE_INTEGER + 1,
        maxLifetimeSeconds: Number.MAX_SAFE_INTEGER + 1,
      },
    ];
    for (const input of bad) {
      expect(
        () => createComputerSpec(input as Parameters<typeof createComputerSpec>[0]),
        JSON.stringify(input),
      ).toThrowError(ComputerProviderError);
      try {
        createComputerSpec(input as Parameters<typeof createComputerSpec>[0]);
        expect.unreachable(JSON.stringify(input));
      } catch (error) {
        expect((error as ComputerProviderError).code).toBe("invalid_spec");
      }
    }
  });
});

describe("assertComputerSpec", () => {
  it("accepts a constructed spec and rejects a raw object with missing timeouts", () => {
    expect(() => assertComputerSpec(createComputerSpec({ profile: "standard" }))).not.toThrow();
    expect(() => assertComputerSpec({ profile: "standard" })).toThrowError(ComputerProviderError);
    expect(() => assertComputerSpec({ profile: "standard", idleTimeoutSeconds: 300 })).toThrowError(
      ComputerProviderError,
    );
    expect(() => assertComputerSpec(null)).toThrowError(ComputerProviderError);
  });

  it("create() rejects a hand-rolled spec without the timeouts (AC2)", async () => {
    const fake = createFakeComputerProvider();
    await rejectsWithCode(
      fake.create({ profile: "standard" } as unknown as Parameters<typeof fake.create>[0]),
      "invalid_spec",
    );
  });
});

describe("createComputerProviderRegistry", () => {
  it("registers a valid provider and resolves it by id (AC3)", () => {
    const registry = createComputerProviderRegistry([createFakeComputerProvider({ id: "a" })]);
    expect(registry.get("a").id).toBe("a");
    assertComputerCapabilities(registry.get("a").capabilities());
  });

  it("throws when a declaration is missing or invalid (AC3)", () => {
    const valid = createFakeComputerProvider({ id: "valid" }).capabilities();
    const { credentialDelivery: _dropped, ...missingDelivery } = valid;
    expect(() =>
      createComputerProviderRegistry([providerWith("bad", missingDelivery)]),
    ).toThrowError(/credentialDelivery/);
    expect(() =>
      createComputerProviderRegistry([
        providerWith("bad", { ...valid, egressControl: "sometimes" }),
      ]),
    ).toThrowError(/egressControl/);
    expect(() =>
      createComputerProviderRegistry([providerWith("bad", { ...valid, profiles: [] })]),
    ).toThrowError(/profiles/);
    expect(() =>
      createComputerProviderRegistry([providerWith("bad", { ...valid, persistentDisk: "yes" })]),
    ).toThrowError(/persistentDisk/);
    expect(() =>
      createComputerProviderRegistry([
        providerWith("bad", { ...valid, surfaces: { ...valid.surfaces, files: "yes" } }),
      ]),
    ).toThrowError(/surfaces\.files/);
  });

  it("throws on colliding ids and names the unknown id", () => {
    expect(() =>
      createComputerProviderRegistry([
        createFakeComputerProvider({ id: "same" }),
        createFakeComputerProvider({ id: "same" }),
      ]),
    ).toThrowError(/duplicate provider id "same"/);
    const registry = createComputerProviderRegistry([createFakeComputerProvider({ id: "a" })]);
    expect(() => registry.get("nope")).toThrowError(/unknown computer provider "nope"/);
  });

  it("switches the default provider on the settings value alone (AC5)", () => {
    const registry = createComputerProviderRegistry([
      createFakeComputerProvider({ id: "cloudflare" }),
      createFakeComputerProvider({ id: "docker-local" }),
    ]);
    // Only the settings value changes; no other state, no data moved.
    expect(registry.resolveDefault("cloudflare").id).toBe("cloudflare");
    expect(registry.resolveDefault("docker-local").id).toBe("docker-local");
    expect(() => registry.resolveDefault("missing")).toThrowError(/unknown computer provider/);
    expect(() => registry.resolveDefault()).toThrowError(/more than one provider/);
  });

  it("falls back to the sole provider only when exactly one exists", () => {
    const solo = createComputerProviderRegistry([createFakeComputerProvider({ id: "only" })]);
    expect(solo.resolveDefault(undefined).id).toBe("only");
    expect(() => createComputerProviderRegistry([]).resolveDefault(undefined)).toThrowError(
      /no providers are registered/,
    );
  });
});

describe("fake computer lifecycle", () => {
  it("computes deadlines from the spec, stops, and destroys idempotently", async () => {
    const fake = createFakeComputerProvider();
    const handle = await fake.create(
      createComputerSpec({
        profile: "standard",
        idleTimeoutSeconds: 300,
        maxLifetimeSeconds: 3600,
      }),
    );
    expect(handle.providerId).toBe("fake");
    expect(handle.state).toBe("running");
    expect(Date.parse(handle.idleDeadlineAt) - Date.parse(handle.createdAt)).toBe(300_000);
    expect(Date.parse(handle.lifetimeDeadlineAt) - Date.parse(handle.createdAt)).toBe(3_600_000);

    await fake.stop(handle);
    const [stopped] = await fake.list();
    expect(stopped?.state).toBe("stopped");

    await fake.destroy(handle);
    await fake.destroy(handle);
    expect(await fake.list()).toEqual([]);
    await rejectsWithCode(fake.getFile(handle, "/tmp/x.txt"), "gone");
  });

  it("rejects profiles outside its declared capabilities with unsupported", async () => {
    const fake = createFakeComputerProvider({ profiles: ["standard"] });
    await rejectsWithCode(
      fake.create(createComputerSpec({ profile: "persistent" })),
      "unsupported",
    );
    // A declared profile still creates.
    const handle = await fake.create(createComputerSpec({ profile: "standard" }));
    expect(handle.profile).toBe("standard");
  });

  it("rejects file reads on stopped computers as gone", async () => {
    const fake = createFakeComputerProvider();
    const handle = await fake.create(createComputerSpec({ profile: "standard" }));
    await fake.putFile(handle, "/tmp/stopped.txt", new TextEncoder().encode("bytes"));
    await fake.stop(handle);
    await rejectsWithCode(fake.getFile(handle, "/tmp/stopped.txt"), "gone");
    await rejectsWithCode(fake.exportArtifact(handle, "/tmp/stopped.txt"), "gone");
    await rejectsWithCode(fake.putFile(handle, "/tmp/stopped.txt", new Uint8Array([1])), "gone");
  });

  it("reports not_found for computers it never saw", async () => {
    const fake = createFakeComputerProvider();
    const ghost = {
      providerId: "fake",
      providerComputerId: "fake-404",
      profile: "standard",
      state: "running",
      createdAt: new Date().toISOString(),
      idleDeadlineAt: new Date().toISOString(),
      lifetimeDeadlineAt: new Date().toISOString(),
    } as const;
    await rejectsWithCode(fake.destroy(ghost), "not_found");
    await rejectsWithCode(fake.getFile(ghost, "/tmp/x.txt"), "not_found");
  });

  it("streams stdout then exactly one exit, and errors like the port says", async () => {
    const fake = createFakeComputerProvider();
    const handle = await fake.create(createComputerSpec({ profile: "standard" }));

    const events = [];
    for await (const event of fake.exec(handle, { argv: ["echo", "hi"] })) events.push(event);
    expect(events[events.length - 1]).toEqual({ type: "exit", code: 0 });
    expect(events.some((event) => event.type === "stdout")).toBe(true);

    const failed = [];
    for await (const event of fake.exec(handle, { argv: ["fail"] })) failed.push(event);
    expect(failed[failed.length - 1]).toEqual({ type: "exit", code: 1 });

    const aborted = [];
    const controller = new AbortController();
    controller.abort();
    for await (const event of fake.exec(handle, {
      argv: ["echo", "hi"],
      signal: controller.signal,
    })) {
      aborted.push(event);
    }
    expect(aborted[aborted.length - 1]).toMatchObject({ type: "error", code: "aborted" });

    expect(() => fake.exec(handle, { argv: [] })).toThrowError(ComputerProviderError);
  });

  it("rejects undeclared surfaces with unsupported", async () => {
    const execLess = createFakeComputerProvider({ surfaces: { execStream: false } });
    const execHandle = await execLess.create(createComputerSpec({ profile: "standard" }));
    try {
      execLess.exec(execHandle, { argv: ["echo", "hi"] });
      expect.unreachable("exec should throw unsupported");
    } catch (error) {
      expect((error as ComputerProviderError).code).toBe("unsupported");
    }

    const filesLess = createFakeComputerProvider({ surfaces: { files: false } });
    const filesHandle = await filesLess.create(createComputerSpec({ profile: "standard" }));
    await rejectsWithCode(
      filesLess.putFile(filesHandle, "/tmp/x.txt", new Uint8Array([1])),
      "unsupported",
    );
    await rejectsWithCode(filesLess.getFile(filesHandle, "/tmp/x.txt"), "unsupported");
    await rejectsWithCode(filesLess.exportArtifact(filesHandle, "/tmp/x.txt"), "unsupported");
  });
});

describe("checkComputerProvider", () => {
  it("passes against the full fake (AC4)", async () => {
    await checkComputerProvider(createFakeComputerProvider());
  });

  it("skips steps for surfaces declared absent instead of failing", async () => {
    await checkComputerProvider(createFakeComputerProvider({ surfaces: { execStream: false } }));
    await checkComputerProvider(createFakeComputerProvider({ surfaces: { files: false } }));
    await checkComputerProvider(
      createFakeComputerProvider({ surfaces: { execStream: false, files: false } }),
    );
  });

  it("names the failing step", async () => {
    const broken = {
      ...createFakeComputerProvider({ id: "broken" }),
      create: () => Promise.reject(new ComputerProviderError("boom", "provider")),
    } satisfies ComputerProvider;
    await expect(checkComputerProvider(broken)).rejects.toThrowError(
      /computer conformance \(broken\): step "create" failed: boom/,
    );
  });

  it("destroys the computer when a post-create step fails", async () => {
    const inner = createFakeComputerProvider({ id: "leaky" });
    let destroyed = 0;
    const failing: ComputerProvider = {
      ...inner,
      exec: (_handle, _request) => {
        throw new ComputerProviderError("exec boom", "provider");
      },
      destroy: async (handle) => {
        destroyed += 1;
        await inner.destroy(handle);
      },
    };
    await expect(checkComputerProvider(failing)).rejects.toThrowError(
      /computer conformance \(leaky\): step "exec stream" failed/,
    );
    expect(destroyed).toBeGreaterThanOrEqual(1);
    expect(await inner.list()).toEqual([]);
  });

  it("destroys the computer when a create-step assertion fails after create", async () => {
    const inner = createFakeComputerProvider({ id: "half-created" });
    let destroyed = 0;
    const badHandle: ComputerProvider = {
      ...inner,
      create: async (spec) => {
        const handle = await inner.create(spec);
        return { ...handle, state: "stopped" as const };
      },
      destroy: async (handle) => {
        destroyed += 1;
        await inner.destroy(handle);
      },
    };
    await expect(checkComputerProvider(badHandle)).rejects.toThrowError(
      /computer conformance \(half-created\): step "create" failed/,
    );
    expect(destroyed).toBeGreaterThanOrEqual(1);
    expect(await inner.list()).toEqual([]);
  });
});
