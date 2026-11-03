// SPDX-License-Identifier: Apache-2.0
// The M4-02 driver for docker-local (M4-05 AC5): adapts the M4-01 `ComputerProvider` to the
// lifecycle's structural `ComputerDriver` (`create`/`destroy`/`list`). Docker-local computers
// carry no disks or snapshots — `persistentDisk` is false — so the resource bags cross the
// seam empty. This module moves lifetimes only, never credentials (M4-00 §4.0): the token
// bridge stays inside the provider.
import type { ComputerProvider, ComputerProviderError } from "@opa/core";
import { createComputerSpec } from "@opa/core";
import type { ComputerDriver } from "@opa/server/computers";

/**
 * Wraps a docker-local provider as the lifecycle's driver. `create` builds the M4-01 spec
 * from the borrow (`idleTimeoutSeconds`/`maxLifetimeSeconds` default 300/3600, as the port
 * requires) and returns the provider-side id the D1 owner record books; `destroy` maps
 * provider errors through, since the sweep treats a throw as "row stays live".
 */
export function asComputerDriver(provider: ComputerProvider): ComputerDriver {
  return {
    async create(spec) {
      // Docker-local offers `standard` only (AC1): any other profile fails the borrow
      // instead of silently booting the wrong kind of computer.
      if (spec.profile !== "standard") {
        throw new Error(`docker-local does not offer profile "${spec.profile}"`);
      }
      const handle = await provider.create(
        createComputerSpec({
          profile: "standard",
          idleTimeoutSeconds: spec.idleTimeoutSeconds,
          maxLifetimeSeconds: spec.maxLifetimeSeconds,
        }),
      );
      return { providerComputerId: handle.providerComputerId, disks: [], snapshots: [] };
    },
    async destroy(providerComputerId, resources) {
      // The driver names the computer only; revive a handle-shaped value for the port.
      const probe = await provider.list();
      const found = probe.find((entry) => entry.providerComputerId === providerComputerId);
      const handle = found ?? {
        providerId: provider.id,
        providerComputerId,
        profile: "standard" as const,
        state: "running" as const,
        createdAt: new Date(0).toISOString(),
        idleDeadlineAt: new Date(0).toISOString(),
        lifetimeDeadlineAt: new Date(0).toISOString(),
      };
      try {
        await provider.destroy(handle);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const code =
          error instanceof Object && "code" in error
            ? String((error as ComputerProviderError).code)
            : "provider";
        throw new Error(`computer destroy failed (${code}): ${detail}`);
      }
      return { disks: resources.disks, snapshots: resources.snapshots };
    },
    async list() {
      const handles = await provider.list();
      return handles.map((handle) => ({
        providerComputerId: handle.providerComputerId,
      }));
    },
  };
}
