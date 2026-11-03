// SPDX-License-Identifier: Apache-2.0
// The M4-01 conformance suite (AC4): create → exec stream → file put/get → artifact export →
// destroy → `capabilities()`, skipping steps for surfaces declared absent. Framework-free — no
// test-runner imports — so M4-04/M4-05 wrap `checkComputerProvider` in their own vitest `it(...)`
// without core importing test tooling (dependency guard). Throws naming the failing step.

import {
  assertComputerCapabilities,
  type ComputerCapabilities,
  type ComputerProvider,
  ComputerProviderError,
  createComputerSpec,
  type ExecEvent,
} from "./computer-provider";

function byteEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function collectStream(stream: AsyncIterable<ExecEvent>): Promise<ExecEvent[]> {
  const events: ExecEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function expectRejects(
  fn: () => Promise<unknown>,
  code: ComputerProviderError["code"],
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ComputerProviderError && error.code === code) return;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(`expected ${code} rejection, got ${detail}`);
  }
  throw new Error(`expected ${code} rejection, call succeeded`);
}

/**
 * Runs the conformance suite against `provider` (M4-01 AC4). Steps for surfaces declared absent
 * are skipped, not failed; a surface claimed `true` must work in the step that exercises it. The
 * same function M4-04/M4-05 wrap against the real adapters, and M4-19 asserts green twice.
 */
export async function checkComputerProvider(provider: ComputerProvider): Promise<void> {
  const ran: { exec: boolean; files: boolean } = { exec: false, files: false };
  const step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("computer conformance")) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`computer conformance (${provider.id}): step "${name}" failed: ${detail}`);
    }
  };

  const capabilities = await step("capabilities", () => {
    const caps = provider.capabilities();
    assertComputerCapabilities(caps);
    return caps;
  });

  const profile = capabilities.profiles.includes("standard")
    ? "standard"
    : (capabilities.profiles[0] as ComputerCapabilities["profiles"][number]);

  const handle = await step("create", async () => {
    const created = await provider.create(createComputerSpec({ profile }));
    if (created.providerId !== provider.id) {
      throw new Error(`providerId is "${created.providerId}", want "${provider.id}"`);
    }
    if (created.providerComputerId.length === 0) {
      throw new Error("providerComputerId is empty");
    }
    if (created.profile !== profile) {
      throw new Error(`profile is "${created.profile}", want "${profile}"`);
    }
    if (created.state !== "running") {
      throw new Error(`state is "${created.state}", want "running"`);
    }
    const spec = createComputerSpec({ profile });
    const createdAt = Date.parse(created.createdAt);
    const idleAt = Date.parse(created.idleDeadlineAt);
    const lifetimeAt = Date.parse(created.lifetimeDeadlineAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(idleAt) || !Number.isFinite(lifetimeAt)) {
      throw new Error("handle deadlines are not ISO date strings");
    }
    if (!(idleAt > createdAt && lifetimeAt >= idleAt)) {
      throw new Error(
        "handle deadlines do not order createdAt < idleDeadlineAt ≤ lifetimeDeadlineAt",
      );
    }
    // Deadlines come from the spec (M4-02's sweep consumes them): allow a minute of clock skew
    // so providers computing server-side still pass.
    const skew = 60_000;
    if (
      Math.abs(idleAt - createdAt - spec.idleTimeoutSeconds * 1000) > skew ||
      Math.abs(lifetimeAt - createdAt - spec.maxLifetimeSeconds * 1000) > skew
    ) {
      throw new Error("handle deadlines do not match the spec timeouts");
    }
    return created;
  });

  if (capabilities.surfaces.execStream) {
    ran.exec = true;
    await step("exec stream", async () => {
      const events = await collectStream(
        provider.exec(handle, { argv: ["echo", "conformance-ok"] }),
      );
      if (events.length === 0) throw new Error("stream ended with no events");
      const terminal = events[events.length - 1] as ExecEvent;
      for (const event of events.slice(0, -1)) {
        if (event.type !== "stdout" && event.type !== "stderr") {
          throw new Error(`non-terminal event of type "${event.type}"`);
        }
      }
      if (terminal === undefined || terminal.type === "stdout" || terminal.type === "stderr") {
        throw new Error("stream ended without exactly one terminal event");
      }
      if (terminal.type === "error") {
        throw new Error(`stream errored (${terminal.code}): ${terminal.message}`);
      }
      if (terminal.code !== 0) {
        throw new Error(`exit code is ${terminal.code}, want 0`);
      }
      const out = events
        .filter((event) => event.type === "stdout")
        .map((event) => (event.type === "stdout" ? event.text : ""))
        .join("");
      if (!out.includes("conformance-ok")) {
        throw new Error("echoed output does not contain the sentinel");
      }
    });
  }

  const artifactPath = "/tmp/conformance-round-trip.txt";
  const payload = new TextEncoder().encode("conformance file bytes");

  if (capabilities.surfaces.files) {
    ran.files = true;
    await step("file put/get", async () => {
      await provider.putFile(handle, artifactPath, payload);
      const roundTripped = await provider.getFile(handle, artifactPath);
      if (!byteEquals(roundTripped, payload)) {
        throw new Error("getFile bytes differ from putFile bytes");
      }
      await expectRejects(
        () => provider.getFile(handle, "/tmp/conformance-missing.txt"),
        "not_found",
      );
    });

    await step("artifact export", async () => {
      const artifact = await provider.exportArtifact(handle, artifactPath);
      if (typeof artifact.name !== "string" || artifact.name.length === 0) {
        throw new Error("artifact name is empty");
      }
      if (!byteEquals(artifact.data, payload)) {
        throw new Error("artifact bytes differ from the file bytes");
      }
    });
  }

  await step("destroy", async () => {
    await provider.destroy(handle);
    await provider.destroy(handle); // idempotent: a second destroy succeeds
    const listed = await provider.list();
    const tombstone = listed.find(
      (entry) => entry.providerComputerId === handle.providerComputerId,
    );
    if (tombstone !== undefined && tombstone.state !== "destroyed") {
      throw new Error(`destroyed computer still lists as "${tombstone.state}"`);
    }
  });

  await step("capabilities", () => {
    const caps = provider.capabilities();
    assertComputerCapabilities(caps);
    if (ran.exec !== caps.surfaces.execStream || ran.files !== caps.surfaces.files) {
      throw new Error("capabilities changed between suite start and end");
    }
  });
}
