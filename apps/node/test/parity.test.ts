// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue, TaskBudget } from "@opa/core";
import { afterAll, describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { createRepository, scopeFromSession } from "../../../packages/db/src/repository";
import {
  blobStoreContract,
  databaseContract,
  memoryContract,
  memoryGateContract,
  memoryRecallContract,
  usageLedgerContract,
} from "../../../test/contract/storage";
import {
  type TaskContextConnectOptions,
  type TaskContextHarness,
  taskContextContract,
  taskStoreContract,
} from "../../../test/contract/tasks";
import { localBlobStore } from "../src/blobs";
import { APP_ROUTES } from "../src/compose";
import { openSqlite, sqliteD1 } from "../src/d1";
import { createSqliteTaskContext, postTaskEvent, type SqliteTaskContextDeps } from "../src/journal";
import { migrate } from "../src/migrate";

const dir = mkdtempSync(join(tmpdir(), "opa-parity-"));
const sqlite = openSqlite(join(dir, "test.sqlite"));
afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const db = () => sqliteD1(sqlite);
const migrated = async () => {
  migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
  return db();
};

databaseContract("SQLite", db);
blobStoreContract("local files", () => localBlobStore(join(dir, "files")));
usageLedgerContract("SQLite", migrated);
memoryContract("SQLite", migrated);
memoryGateContract("SQLite", migrated);
memoryRecallContract("SQLite", migrated);
taskStoreContract("SQLite", migrated, () => localBlobStore(join(dir, "files")));

let taskSeq = 0;
async function connectTaskContext(
  options: TaskContextConnectOptions = {},
): Promise<TaskContextHarness> {
  migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
  taskSeq += 1;
  const userId = `parity-${taskSeq}-${Date.now()}`;
  const conversationId = `c-${userId}`;
  const taskId = `t-${userId}`;
  const instanceId = `inst-${userId}`;
  const DB = db();
  await DB.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'P', 'owner')")
    .bind(userId)
    .run();
  const stub = {} as never;
  const repo = createRepository({ DB, FILES: localBlobStore(join(dir, "files")), ASSISTANT: stub });
  const scoped = repo.forUser(scopeFromSession({ userId }));
  await scoped.chat.open(conversationId, "Parity");
  await scoped.tasks.create({
    id: taskId,
    conversationId,
    workflowInstanceId: instanceId,
    kind: "turn",
    mode: "background",
  });
  await scoped.tasks.markRunning(taskId, options.startedAt ?? Date.now());
  const progressEvents: TaskContextHarness["progressEvents"] = [];
  const budgetCalls: string[] = [];
  const outputIds: string[] = [];
  const outputs = {
    put: async (id: string, value: string) => {
      outputIds.push(id);
      return scoped.stepOutputs.put(id, value);
    },
    get: (id: string) => scoped.stepOutputs.get(id),
  };
  const budget: TaskBudget = {
    reserve: async (key) => {
      budgetCalls.push(`reserve:${key}`);
      return { maxOutputTokens: 8, reservedMicroUsd: 0 };
    },
    settle: async (key) => {
      budgetCalls.push(`settle:${key}`);
    },
    release: async (key) => {
      budgetCalls.push(`release:${key}`);
    },
    start: async (budgetMicroUsd) => ({ budgetMicroUsd: budgetMicroUsd ?? 500_000 }),
    end: async () => 0,
    allowToolCall: async () => true,
  };
  const deps: SqliteTaskContextDeps = {
    db: DB,
    taskId,
    instanceId,
    conversationId,
    turnId: "turn1",
    startedAt: options.startedAt ?? Date.now(),
    mode: "background",
    readStatus: async () => (await scoped.tasks.get(taskId))?.status,
    outputs,
    budget,
    onProgress: (p) => {
      progressEvents.push({ seq: p.seq, type: p.type, payload: p.payload });
    },
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  };
  return {
    ctx: createSqliteTaskContext(deps),
    taskId,
    instanceId,
    cancel: async () => {
      await scoped.tasks.cancel(taskId);
    },
    reconnect: () => createSqliteTaskContext({ ...deps }),
    postEvent: (type, payload) => postTaskEvent(DB, instanceId, type, payload as JsonValue),
    persistedText: async () => {
      const rows = await DB.prepare("SELECT output FROM task_steps WHERE instance_id = ?")
        .bind(instanceId)
        .all();
      return JSON.stringify(
        (rows.results as { output: string }[]).map((r) => JSON.parse(r.output)),
      );
    },
    outputIds: () => outputIds,
    readOutput: async (id) => (await scoped.stepOutputs.get(id))?.text() ?? null,
    progressEvents,
    budgetCalls,
  };
}

taskContextContract("SQLite journal", connectTaskContext);

describe("deleted-task steps persist nothing", () => {
  it("a step whose task row is deleted mid-step returns its value but journals no row", async () => {
    const h = await connectTaskContext();
    const out = await h.ctx.step("s1", async () => {
      // Account deletion takes the task row while the step is running.
      await db().prepare("DELETE FROM tasks WHERE id = ?").bind(h.taskId).run();
      return "finished";
    });
    expect(out).toBe("finished");
    expect(await h.persistedText()).toBe("[]");
  });

  it("a deleted task's large step offloads no output file either", async () => {
    const h = await connectTaskContext();
    const big = "x".repeat(2 * 1024 * 1024);
    const out = await h.ctx.step("s1", async () => {
      await db().prepare("DELETE FROM tasks WHERE id = ?").bind(h.taskId).run();
      return big;
    });
    expect(out).toBe(big);
    expect(await h.persistedText()).toBe("[]");
    expect(h.outputIds()).toEqual([]);
  });
});

describe("Node composition", () => {
  it("applies the same migrations as wrangler, once", () => {
    const migrations = join(import.meta.dirname, "../../../migrations");
    const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8"));
    const db = openSqlite(":memory:");
    expect(migrate(db, migrations)).toEqual(
      journal.entries.map((e: { tag: string }) => `${e.tag}.sql`),
    );
    expect(migrate(db, migrations)).toEqual([]);
    db.close();
  });

  it("routes the same paths to the app as wrangler.jsonc", () => {
    const config = unstable_readConfig({
      config: join(import.meta.dirname, "../../../wrangler.jsonc"),
    });
    expect(APP_ROUTES).toEqual(config.assets?.run_worker_first);
  });
});
