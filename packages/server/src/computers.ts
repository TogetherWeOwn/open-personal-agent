// SPDX-License-Identifier: Apache-2.0
// The computer lifecycle module (M4-02): the only unscoped computer access in the app — the
// scoped-access lint confines computer-scope minting to this file and `@opa/db`, mirroring the
// task/export pattern. It owns the D1 owner record through `computerStore`, borrows one computer per
// user and, where practical, per task (D5), enforces the idle timeout and max lifetime even when
// the task, DO and browser vanish (the reconciler sweep), and destroys through the provider
// API on account deletion.
//
// The provider seam is a structural subset of the M4-01 `ComputerProvider` port
// (`create`/`destroy`/`list`): no M4-01 import, so this card compiles and lands before it. When
// M4-01 lands, its adapter satisfies `ComputerDriver` as written, and this module re-points to
// the port type without changing behaviour. This module never handles capability tokens
// (M4-00 §4.0): it moves the computer's lifetime, never a credential — no session cookie, model
// key or wider-audience token ever enters a computer through here.
import {
  COMPUTER_CONCURRENCY_CAP,
  COMPUTER_IDLE_TAIL_MS,
  type ComputerEndReason,
  type ComputerRow,
  computerStore,
} from "@opa/db/computers";
import { createRepository, TASK_TERMINAL_STATUSES, type UserScope } from "@opa/db/repository";
import { log } from "@opa/log";
import type { AppPorts } from "./env";

/** What the lifecycle asks a provider to make: the M4-01 `create` surface, structurally. */
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

/** What a borrow names: the task it serves and the kind of computer it needs. */
export interface BorrowSpec {
  taskId: string;
  provider: string;
  profile: string;
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
}

const TERMINAL = TASK_TERMINAL_STATUSES as readonly string[];

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed|unique/i.test(error.message);

/**
 * Mode-A borrow (M4-02 AC2, ADR 0007 #5): a tool call starts or reuses the task's computer.
 * One computer serves one user and, where practical, one task — never shared, pooled or
 * reassigned (D5). A borrow reuses the task's computer only within the 60 s idle tail of its
 * last use; anything older, or for another task, is destroyed first and replaced. The
 * deployment-wide concurrency cap (COST-2) is enforced before anything is created. The
 * provider-side id the driver returns is stored as bookkeeping only, never as an identity.
 */
export async function borrowComputer(
  env: AppPorts,
  scope: UserScope,
  spec: BorrowSpec,
  driver: ComputerDriver,
  now: number = Date.now(),
): Promise<{ computer: ComputerRow; reused: boolean }> {
  const repo = createRepository(env);
  const task = await repo.forUser(scope).tasks.get(spec.taskId);
  if (!task) throw new Error("computer_no_task");
  if (TERMINAL.includes(task.status)) throw new Error("computer_task_ended");
  const store = computerStore(env);
  for (const other of await store.listActiveForUser(scope.userId)) {
    if (
      other.taskId === spec.taskId &&
      other.provider === spec.provider &&
      other.profile === spec.profile
    ) {
      if (now - other.lastUsedAt <= COMPUTER_IDLE_TAIL_MS) {
        const reused = await store.heartbeat(other.id, now);
        if (reused) return { computer: reused, reused: true };
      }
      // A provider failure leaves the old row live for the next tick — borrowing on
      // top of it would leave two live computers for one user, the same failure the
      // sweep refuses. Abort the borrow instead.
      if (!(await destroyLive(store, driver, other, "replaced", now))) {
        throw new Error("computer_replace_failed");
      }
    } else {
      // Another task's — or another kind's — computer: D5 forbids a second live one.
      if (!(await destroyLive(store, driver, other, "replaced", now))) {
        throw new Error("computer_replace_failed");
      }
    }
  }
  if ((await store.countActive()) >= COMPUTER_CONCURRENCY_CAP) {
    throw new Error("computer_limit");
  }
  const created = await driver.create({
    provider: spec.provider,
    profile: spec.profile,
    taskId: spec.taskId,
    idleTimeoutSeconds: spec.idleTimeoutSeconds ?? 300,
    maxLifetimeSeconds: spec.maxLifetimeSeconds ?? 3_600,
  });
  let computer: ComputerRow;
  try {
    computer = await store.create(
      {
        userId: scope.userId,
        provider: spec.provider,
        profile: spec.profile,
        providerComputerId: created.providerComputerId,
        taskId: spec.taskId,
        disks: created.disks,
        snapshots: created.snapshots,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        maxLifetimeSeconds: spec.maxLifetimeSeconds,
      },
      now,
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A racing borrow claimed the user's live slot first: its row is the owner's, so
    // reuse it when it is this borrow's computer. The provider-side `created` above
    // has no D1 row — the sweep's orphan leg reaps it via `list()`. Anything else
    // (another task's computer won the race) answers busy: the caller retries, and
    // the retry sees the winner and replaces it normally.
    const live = await store.listActiveForUser(scope.userId);
    const winner = live.find(
      (row) =>
        row.taskId === spec.taskId &&
        row.provider === spec.provider &&
        row.profile === spec.profile &&
        now - row.lastUsedAt <= COMPUTER_IDLE_TAIL_MS,
    );
    if (winner) {
      const reused = await store.heartbeat(winner.id, now);
      if (reused) return { computer: reused, reused: true };
    }
    throw new Error("computer_busy");
  }
  // The pre-create cap check races: two borrows can both pass it, so verify the claim.
  // An overshoot destroys what this borrow just made and refuses — the retry then sees
  // the winner. D5's per-user index already bounds the race to distinct users.
  if ((await store.countActive()) > COMPUTER_CONCURRENCY_CAP) {
    await destroyLive(store, driver, computer, "replaced", now);
    throw new Error("computer_limit");
  }
  return { computer, reused: false };
}

/**
 * A tool call used the computer: stamp the use through the row's own scope. `null` when the
 * row is gone or is not the caller's — the caller borrows anew, as if it never existed.
 */
export async function touchComputer(
  env: AppPorts,
  scope: UserScope,
  computerId: string,
  now: number = Date.now(),
): Promise<ComputerRow | null> {
  const repo = createRepository(env);
  const found = await repo.scopeForComputer(computerId);
  if (!found || found.computer.userId !== scope.userId) return null;
  return computerStore(env).heartbeat(found.computer.id, now);
}

/** Destroy through the provider where one is configured, then finish the row. */
async function destroyLive(
  store: ReturnType<typeof computerStore>,
  driver: ComputerDriver | undefined,
  row: ComputerRow,
  reason: ComputerEndReason,
  now: number,
): Promise<boolean> {
  if (driver) {
    const resources = computerResourcesOf(row);
    try {
      await driver.destroy(row.providerComputerId, resources);
    } catch {
      // Leave the row live for the next tick, as the export sweep leaves a row whose
      // objects would not delete: a moved row must never orphan a billing computer.
      return false;
    }
  }
  return (await store.finish(row.id, reason, now)) !== null;
}

const computerResourcesOf = (row: ComputerRow): { disks: string[]; snapshots: string[] } => {
  const names = (value: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  };
  return { disks: names(row.disks), snapshots: names(row.snapshots) };
};

/** What one sweep destroyed, destroyed-for, or failed on. */
export interface ComputerSweepSummary {
  idle: number;
  lifetime: number;
  taskEnded: number;
  orphans: number;
  errors: number;
}

/**
 * The reconciler's computer sweep (M4-02 AC3, COST-6): idle timeout and max lifetime are
 * enforced from the D1 deadlines even if the task, DO and browser all vanished; a computer
 * whose task ended or was cancelled is destroyed by the same path; and the provider's own
 * `list()` is reconciled against the owner records, destroying what no live row claims. The
 * sweep records every destroy as an audit row and returns what it did, like the other parts.
 */
export async function sweepComputers(
  env: AppPorts,
  driver: ComputerDriver | undefined,
  now: number = Date.now(),
): Promise<ComputerSweepSummary> {
  const store = computerStore(env);
  const summary: ComputerSweepSummary = {
    idle: 0,
    lifetime: 0,
    taskEnded: 0,
    orphans: 0,
    errors: 0,
  };
  const act = async (row: ComputerRow, reason: ComputerEndReason): Promise<boolean> => {
    const done = await destroyLive(store, driver, row, reason, now);
    if (done) {
      if (reason === "idle") summary.idle += 1;
      else if (reason === "lifetime") summary.lifetime += 1;
      else summary.taskEnded += 1;
    } else {
      summary.errors += 1;
    }
    return done;
  };
  const live = await store.activeWithTasks();
  const known = new Set(live.map((r) => r.computer.providerComputerId));
  for (const { computer, taskStatus, taskUserId } of live) {
    let reason: ComputerEndReason | null = null;
    // A null binding is a computer borrowed outside any task ("where practical", AC2): only
    // the deadlines govern it. A non-null binding to a missing, foreign or finished task —
    // including a cancelled one — destroys by this same path (AC3).
    if (
      computer.taskId !== null &&
      (taskStatus === null || taskUserId !== computer.userId || TERMINAL.includes(taskStatus))
    ) {
      reason = "task_ended";
    } else if (now >= computer.lifetimeDeadline) {
      reason = "lifetime";
    } else if (now >= computer.idleDeadline) {
      reason = "idle";
    }
    if (reason && (await act(computer, reason))) known.delete(computer.providerComputerId);
  }
  if (driver) {
    let listed: { providerComputerId: string }[];
    try {
      listed = await driver.list();
    } catch {
      summary.errors += 1;
      listed = [];
    }
    for (const { providerComputerId } of listed) {
      if (known.has(providerComputerId)) continue;
      try {
        await driver.destroy(providerComputerId, { disks: [], snapshots: [] });
        await store.sweptOrphan(providerComputerId, now);
        summary.orphans += 1;
      } catch {
        summary.errors += 1;
      }
    }
  }
  const acted = summary.idle + summary.lifetime + summary.taskEnded + summary.orphans;
  if (acted > 0) log.info("computers.sweep", { count: acted });
  if (summary.errors > 0) log.error("computers.sweep", { count: summary.errors });
  return summary;
}
