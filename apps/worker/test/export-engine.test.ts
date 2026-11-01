// SPDX-License-Identifier: Apache-2.0
// The export Workflow's run (M3-20 AC1): every item type stages through the scoped repository,
// the staged files stream into the final ZIP, and the row ends ready — while a rerun of the
// finished export changes nothing, an unknown instance fails, a failing run ends failed, the
// sweep expires stale rows and deletes their objects, and one run goes through the real
// Workflow engine binding.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { JsonValue, TaskStepper } from "@opa/core";
import { EXPORT_ITEM_TYPES, SWEEP_BATCH, sweepExports } from "@opa/db/export";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import { beforeAll, describe, expect, it } from "vitest";
import type { WorkerEnv } from "../src/compose";
import { executeExport } from "../src/export-workflow";

const env = workerEnv as unknown as WorkerEnv & {
  TEST_MIGRATIONS: D1Migration[];
  EXPORT_WORKFLOW: Workflow;
};
const repo = createRepository(env);
const alice = repo.forUser(scopeFromSession({ userId: "alice" }));
const bob = repo.forUser(scopeFromSession({ userId: "bob" }));

/** Runs every step inline, like the engine would, recording the step names it ran. */
class FakeStepper {
  steps: string[] = [];
  async do<T extends JsonValue>(name: string, _config: unknown, fn: () => Promise<T>): Promise<T> {
    this.steps.push(name);
    return fn();
  }
  async sleep(): Promise<void> {}
  async waitForEvent<T extends JsonValue>(): Promise<{ payload: T }> {
    return { payload: null as T };
  }
}
const stepper = (): TaskStepper => new FakeStepper() as unknown as TaskStepper;

let seq = 0;
/** A running export row named by its own Workflow instance id. */
async function makeExport(expiresAt = Date.now() + 3600000) {
  seq += 1;
  const id = `x${seq}`;
  const instanceId = `exp-engine-${seq}`;
  expect(await alice.exports.create({ id, workflowInstanceId: instanceId, expiresAt })).toBe(true);
  return { id, instanceId };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, role) VALUES ('alice', 'A', 'owner'), ('bob', 'B', 'member')",
  ).run();
  await alice.createConversation("ca", "Alice's");
  await bob.createConversation("cb", "Bob's");
});

/** Seeds one of nearly everything the walk carries, across both users. */
async function seed() {
  await alice.tasks.create({
    id: "xt1",
    conversationId: "ca",
    workflowInstanceId: "xinst-1",
    kind: "turn",
    mode: "background",
  });
  await bob.tasks.create({
    id: "xt2",
    conversationId: "cb",
    workflowInstanceId: "xinst-2",
    kind: "turn",
    mode: "background",
  });
  await alice.attachments.create({
    id: "xa1",
    name: "note.txt",
    mediaType: "text/plain",
    kind: "text",
    sizeBytes: 5,
  });
  await alice.attachments.putObject(
    "xa1",
    new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(new TextEncoder().encode("hello"));
        c.close();
      },
    }),
    "text/plain",
    5,
  );
  // A row with no object exercises the empty-body path; Bob's stays out of Alice's export.
  await alice.attachments.create({
    id: "xa2",
    name: "gone.pdf",
    mediaType: "application/pdf",
    kind: "pdf",
    sizeBytes: 0,
  });
  await env.FILES.put("u/alice/files/tool-output.txt", "tool bytes");
  await env.FILES.put("u/alice/task-outputs/offloaded.json", `{"offloaded":true}`);
  await env.FILES.put("u/bob/files/other.txt", "not hers");
  await alice.usage.record({
    providerId: "p",
    model: "m",
    usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
  });
  await env.DB.prepare(
    "INSERT INTO audit_log (user_id, action, module, result) VALUES ('alice', 'exported', 'm', 'ok')",
  ).run();
}

/** The central directory's entry names, in order. */
function zipNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const eocd = bytes.length - 22; // no comment: the end record is exactly 22 bytes
  expect(u32(eocd)).toBe(0x06054b50);
  const names: string[] = [];
  let at = u32(eocd + 16);
  for (let i = 0, count = u16(eocd + 10); i < count; i++) {
    expect(u32(at)).toBe(0x02014b50);
    const nameLength = u16(at + 28);
    names.push(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }
  return names;
}

async function zipBytes(id: string): Promise<Uint8Array> {
  const object = await env.FILES.get(`u/alice/exports/${id}.zip`);
  if (!object) throw new Error(`missing ZIP for export ${id}`);
  return new Uint8Array(await object.arrayBuffer());
}

describe("executeExport", () => {
  it("stages every item type, zips them, and marks the export ready", async () => {
    await seed();
    const { id, instanceId } = await makeExport();
    const ran = new FakeStepper();
    await executeExport(env, instanceId, ran as unknown as TaskStepper);
    // One step per item type, then the finish and the cleanup.
    expect(ran.steps).toEqual([
      ...EXPORT_ITEM_TYPES.map((type) => `export:${type}`),
      "export:finish",
      "export:cleanup",
    ]);

    const row = await alice.exports.get(id);
    expect(row?.status).toBe("ready");
    expect(row?.sizeBytes).toBeGreaterThan(0);
    expect(row?.readyAt).toBeGreaterThan(0);
    // The cleanup step deleted the staged files; the ZIP beside them remains.
    expect(await alice.exports.listPrefix(alice.exports.stagedPrefix(id))).toEqual([]);

    const names = zipNames(await zipBytes(id));
    for (const type of EXPORT_ITEM_TYPES) {
      // Messages stage one file per conversation, not one messages.json.
      if (type === "artifacts" || type === "attachments" || type === "messages") continue;
      expect(names).toContain(`${type}.json`);
    }
    expect(names).toContain("messages/ca.json");
    expect(names).toContain("artifacts.json");
    expect(names).toContain("artifacts/files/tool-output.txt");
    expect(names).toContain("artifacts/task-outputs/offloaded.json");
    expect(names).toContain("attachments.json");
    expect(names).toContain("attachments/xa1");
    expect(names).toContain("attachments/xa2");
    // Bob's rows and files are nowhere in her archive.
    const text = new TextDecoder().decode(await zipBytes(id));
    expect(text).not.toContain("xt2");
    expect(text).not.toContain("other.txt");
    expect(text).toContain("hello"); // attachment bytes rode along
    expect(text).toContain("tool bytes"); // so did the tool artifact
  });

  it("a rerun of the finished export changes nothing", async () => {
    const { id, instanceId } = await makeExport();
    await executeExport(env, instanceId, stepper());
    const before = await alice.exports.get(id);
    const bytes = await zipBytes(id);
    await executeExport(env, instanceId, stepper());
    // Every step saw the finished row and skipped: same outcome, same bytes.
    expect(await alice.exports.get(id)).toEqual(before);
    expect(await zipBytes(id)).toEqual(bytes);
  });

  it("an unknown instance fails without touching any row", async () => {
    await expect(executeExport(env, "exp-engine-nope", stepper())).rejects.toThrow(
      /no exports row/,
    );
    await executeExport(env, "exp-engine-nope", stepper()).catch((err) => {
      expect(err).toBeInstanceOf(NonRetryableError);
    });
  });

  it("a failing run marks the export failed, keeping the reason", async () => {
    const { id, instanceId } = await makeExport();
    const down = {
      ...env,
      FILES: new Proxy(env.FILES, {
        get: (target, prop, receiver) =>
          prop === "put"
            ? async () => {
                throw new Error("R2 is down");
              }
            : Reflect.get(target, prop, receiver),
      }),
    } as unknown as WorkerEnv;
    await expect(executeExport(down, instanceId, stepper())).rejects.toThrow(/R2 is down/);
    const row = await alice.exports.get(id);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("R2 is down");
  });

  it("aborts the ZIP upload when streaming it fails, leaving no half-written archive", async () => {
    const { id, instanceId } = await makeExport(Date.now() + 3_600_000);
    let aborted = false;
    const failingParts = {
      ...env,
      // R2 methods reject a detached call, so untrapped methods stay bound to the target.
      FILES: new Proxy(env.FILES, {
        get: (target, prop, receiver) => {
          if (prop === "createMultipartUpload")
            return async (...args: unknown[]) => {
              const create = Reflect.get(target, prop, receiver) as (
                ...a: unknown[]
              ) => Promise<object>;
              const upload = await create.apply(target, args);
              return new Proxy(upload, {
                get: (t, p, r) => {
                  if (p === "abort")
                    return async () => {
                      aborted = true;
                    };
                  if (p === "uploadPart")
                    return async () => {
                      throw new Error("part failed");
                    };
                  const value = Reflect.get(t, p, r);
                  return typeof value === "function" ? value.bind(t) : value;
                },
              });
            };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as unknown as WorkerEnv;
    await expect(executeExport(failingParts, instanceId, stepper())).rejects.toThrow(/part failed/);
    expect(aborted).toBe(true);
    expect((await alice.exports.get(id))?.status).toBe("failed");
  });

  it("expires the row instead of readying it when the expiry passes mid-run", async () => {
    const { id, instanceId } = await makeExport(Date.now() - 1);
    await executeExport(env, instanceId, stepper());
    // The finish found a past-expiry row: expired, with neither a ZIP nor staged files left.
    expect((await alice.exports.get(id))?.status).toBe("expired");
    expect(await env.FILES.get(`u/alice/exports/${id}.zip`)).toBeNull();
    expect(await alice.exports.listPrefix(alice.exports.stagedPrefix(id))).toEqual([]);
  });

  it("carries every memory row and proposal in the ZIP, whatever the status", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source) VALUES ('me-old', 'alice', 'fact', 'old', 'user', 'superseded', 'create', 'chat')",
      ),
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source) VALUES ('me-new', 'alice', 'fact', 'new', 'user', 'active', 'update', 'chat')",
      ),
      env.DB.prepare(
        "INSERT INTO memories (id, user_id, kind, text, trust, status, op, source, expires_at) VALUES ('me-stale', 'alice', 'fact', 'stale', 'user', 'proposed', 'create', 'chat', 1)",
      ),
    ]);
    const { id, instanceId } = await makeExport(Date.now() + 3_600_000);
    await executeExport(env, instanceId, stepper());
    expect((await alice.exports.get(id))?.status).toBe("ready");
    const text = new TextDecoder().decode(await zipBytes(id));
    expect(text).toContain("me-old");
    expect(text).toContain("me-new");
    expect(text).toContain("me-stale");
    expect(text).toContain("superseded");
  });
});

describe("sweepExports", () => {
  it("expires stale rows, deletes their objects, and leaves the live one", async () => {
    const now = 10_000;
    // A ready export with objects, a failed one, and a run that never finished.
    const ready = await makeExport(now - 1);
    await alice.exports.finishReady(ready.id, 7, now - 2);
    await env.FILES.put(`u/alice/exports/${ready.id}.zip`, "zip");
    await env.FILES.put(`${alice.exports.stagedPrefix(ready.id)}leftover.json`, "{}");
    const failed = await makeExport(now - 1);
    await alice.exports.finishFailed(failed.id, "boom");
    // Still live: the same expiry, a later clock. It finishes before the stuck run starts:
    // one export runs at a time.
    const live = await makeExport(now + 1_000);
    await alice.exports.finishReady(live.id, 7, now - 2);
    await env.FILES.put(`u/alice/exports/${live.id}.zip`, "zip");
    const stuck = await makeExport(now - 1);
    await env.FILES.put(`${alice.exports.stagedPrefix(stuck.id)}partial.json`, "{}");

    expect(await sweepExports(env, () => now)).toEqual({ expired: 3 });
    expect((await alice.exports.get(ready.id))?.status).toBe("expired");
    expect((await alice.exports.get(failed.id))?.status).toBe("expired");
    expect((await alice.exports.get(stuck.id))?.status).toBe("expired");
    expect(await env.FILES.get(`u/alice/exports/${ready.id}.zip`)).toBeNull();
    expect(await alice.exports.listPrefix(alice.exports.stagedPrefix(ready.id))).toEqual([]);
    expect(await alice.exports.listPrefix(alice.exports.stagedPrefix(stuck.id))).toEqual([]);
    // The live export keeps its row and its ZIP; a second sweep finds nothing.
    expect((await alice.exports.get(live.id))?.status).toBe("ready");
    expect(await env.FILES.get(`u/alice/exports/${live.id}.zip`)).not.toBeNull();
    expect(await sweepExports(env, () => now)).toEqual({ expired: 0 });
  });

  it("leaves a row for the next tick when its objects fail to delete", async () => {
    const now = 10_000;
    const { id } = await makeExport(now - 1);
    await alice.exports.finishReady(id, 7, now - 2);
    await env.FILES.put(`u/alice/exports/${id}.zip`, "zip");
    const failingDeletes = {
      ...env,
      // R2 methods reject a detached call, so untrapped methods stay bound to the target.
      FILES: new Proxy(env.FILES, {
        get: (target, prop, receiver) => {
          if (prop === "delete")
            return async () => {
              throw new Error("R2 is down");
            };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as unknown as WorkerEnv;
    // Nothing moved: a moved row never comes back, so its files would be orphaned.
    expect(await sweepExports(failingDeletes, () => now)).toEqual({ expired: 0 });
    expect((await alice.exports.get(id))?.status).toBe("ready");
    // The next tick cleans it up once deletes work again.
    expect(await sweepExports(env, () => now)).toEqual({ expired: 1 });
    expect((await alice.exports.get(id))?.status).toBe("expired");
    expect(await env.FILES.get(`u/alice/exports/${id}.zip`)).toBeNull();
  });

  it("reaches rows past a stuck batch instead of starving them", async () => {
    const now = 10_000;
    // A full batch whose deletes keep failing, then one more stale row behind it: without
    // cursor paging the limit would select the same stuck rows on every tick.
    const stuck: string[] = [];
    for (let i = 0; i < SWEEP_BATCH; i++) {
      const row = await makeExport(now - 1);
      await alice.exports.finishReady(row.id, 7, now - 2);
      stuck.push(row.id);
    }
    const { id: late } = await makeExport(now - 1);
    await alice.exports.finishReady(late, 7, now - 2);
    await env.FILES.put(`u/alice/exports/${late}.zip`, "zip");
    const partialFailure = {
      ...env,
      // R2 methods reject a detached call, so untrapped methods stay bound to the target.
      FILES: new Proxy(env.FILES, {
        get: (target, prop, receiver) => {
          if (prop === "delete")
            return async (key: string) => {
              if (key.includes(late))
                return (target.delete as (key: string) => Promise<void>).call(target, key);
              throw new Error("R2 is down");
            };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as unknown as WorkerEnv;
    // The stuck batch stays for the next tick, but the later row is still reached this one.
    expect(await sweepExports(partialFailure, () => now)).toEqual({ expired: 1 });
    expect((await alice.exports.get(late))?.status).toBe("expired");
    expect(await env.FILES.get(`u/alice/exports/${late}.zip`)).toBeNull();
    for (const id of stuck) expect((await alice.exports.get(id))?.status).toBe("ready");
  });
});

describe("ExportWorkflow engine", () => {
  it("runs an export through the real Workflow binding", async () => {
    const { id, instanceId } = await makeExport(Date.now() + 3_600_000);
    await env.EXPORT_WORKFLOW.create({ id: instanceId, params: {} });
    const deadline = Date.now() + 15_000;
    let status: string | undefined;
    while (Date.now() < deadline && status !== "ready") {
      status = (await alice.exports.get(id))?.status;
      if (status !== "ready") await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe("ready");
    expect(zipNames(await zipBytes(id))).toContain("conversations.json");
  });
});
