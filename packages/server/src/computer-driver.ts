// SPDX-License-Identifier: Apache-2.0
// The provider seam for the computer lifecycle (M4-02): a structural subset of the M4-01
// `ComputerProvider` port (`create`/`destroy`/`list`) with no M4-01 import, so it compiles
// before that card. When M4-01 lands, its adapter satisfies `ComputerDriver` as written.
// This leaf module imports nothing: `env.ts` (the port) and `computers.ts` (the lifecycle)
// both point here, so neither imports the other. It never handles capability tokens
// (M4-00 §4.0): it moves the computer's lifetime, never a credential.

/** What a borrow provisions: the M4-01 `create` surface, structurally. */
export interface ComputerProvision {
  providerComputerId: string;
  disks?: string[];
  snapshots?: string[];
}

/**
 * What the lifecycle asks a provider to do: the M4-01 port's `create`/`destroy`/`list`,
 * structurally. `list` names every provider-side computer the deployment holds, so the sweep
 * can destroy what no D1 row claims (COST-6). `destroy` reports the provider resources it
 * removed, for the deletion report.
 */
export interface ComputerDriver {
  create(spec: {
    provider: string;
    profile: string;
    taskId: string | null;
    idleTimeoutSeconds: number;
    maxLifetimeSeconds: number;
  }): Promise<ComputerProvision>;
  destroy(
    providerComputerId: string,
    resources: { disks: string[]; snapshots: string[] },
  ): Promise<{ disks?: string[]; snapshots?: string[] }>;
  list(): Promise<{ providerComputerId: string }[]>;
}
