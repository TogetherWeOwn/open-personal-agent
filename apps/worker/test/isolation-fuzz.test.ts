// SPDX-License-Identifier: Apache-2.0
// M3-21 🔒 data isolation (21b): AC2 (R2 keys, Durable Object names and Workflow instance ids
// can't be steered by client input, fuzzed with `:`, `/` and A's IDs), AC3 (B's recall never
// returns A's memories, near-duplicates seeded in both) and AC4 (B's turns can't use A's model
// key; B can't cancel, resume or read A's task; a Workflow step acts only as its task row's user,
// M3-12 AC9). It records every R2 key, DO name and Workflow instance the app touches, so a route
// added later is held to the same rule. The approval POST arrives with M3-07: its route takes an
// ID, so isolation.test.ts's enumeration (AC7) fails until it has a case there.
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { ModelEvent, ModelProvider, TaskStepper } from "@opa/core";
import { type MemoryTool, memoryTools } from "@opa/db/memory-tools";
import {
  createRepository,
  scopeForAssistant,
  scopeFromSession,
  type UserScope,
} from "@opa/db/repository";
import { credentialBinding } from "@opa/providers";
import { resolveChatModel } from "@opa/server/chat-model";
import { PUBLIC_ROUTES } from "@opa/server/session";
import { decrypt } from "@opa/vault";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { compose, type WorkerEnv } from "../src/compose";
import { executeTask, newTaskTurnState } from "../src/task-workflow";
import { workerApp as app } from "../src/worker-app";
import { env } from "./helpers/app";
import {
  as,
  BASE_URL,
  bindings,
  leaked,
  type Seeded,
  seedBoth,
  snapshot,
} from "./helpers/isolation";

const raw = workerEnv as unknown as WorkerEnv & {
  TEST_MIGRATIONS: D1Migration[];
  TASK_WORKFLOW: Workflow;
  EXPORT_WORKFLOW: Workflow;
};
const repo = createRepository(env);
const scopeOf = (user: Seeded) => scopeFromSession({ userId: user.id });
const forUser = (user: Seeded) => repo.forUser(scopeOf(user));

/** What the app named while a test ran: R2 keys and prefixes, DO names, Workflow instances. */
interface Touched {
  keys: string[];
  names: string[];
  instances: string[];
  /** Workflow instances created, with the params they were given. */
  created: { id: string | undefined; params: unknown }[];
}

/** Records every name that reaches the R2, DO and Workflow bindings, and still calls them. */
function record(): Touched {
  const touched: Touched = { keys: [], names: [], instances: [], created: [] };
  const files = raw.FILES as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ["get", "head", "put", "delete", "list", "createMultipartUpload"]) {
    const original = files[method]?.bind(raw.FILES);
    if (!original) continue;
    vi.spyOn(files, method).mockImplementation((first: unknown, ...rest: unknown[]) => {
      const named = method === "list" ? [(first as { prefix?: string })?.prefix ?? ""] : [first];
      touched.keys.push(...named.flat().map(String));
      return original(first, ...rest);
    });
  }
  const names = raw.ASSISTANT.idFromName.bind(raw.ASSISTANT);
  vi.spyOn(raw.ASSISTANT, "idFromName").mockImplementation((name: string) => {
    touched.names.push(name);
    return names(name);
  });
  for (const workflow of [raw.TASK_WORKFLOW, raw.EXPORT_WORKFLOW]) {
    const get = workflow.get.bind(workflow);
    vi.spyOn(workflow, "get").mockImplementation((id: string) => {
      touched.instances.push(id);
      return get(id);
    });
    const create = workflow.create.bind(workflow);
    vi.spyOn(workflow, "create").mockImplementation((options) => {
      touched.created.push({ id: options?.id, params: options?.params });
      return create(options);
    });
    const createBatch = workflow.createBatch.bind(workflow);
    vi.spyOn(workflow, "createBatch").mockImplementation((batch) => {
      touched.created.push(...batch.map((o) => ({ id: o.id, params: o.params })));
      return createBatch(batch);
    });
  }
  return touched;
}

/** Every key `touched` names is inside `user`'s prefix, every DO is theirs, no Workflow is woken. */
function onlyOwn(touched: Touched, user: Seeded, own: { instances?: string[] } = {}) {
  // The deployment-wide reads (`fileBytes` lists the whole bucket; the health probe) name no user.
  const keys = touched.keys.filter((k) => k !== "" && k !== "health/probe");
  expect(keys.filter((k) => !k.startsWith(`u/${user.id}/`))).toEqual([]);
  expect(touched.names.filter((n) => n !== `u:${user.id}`)).toEqual([]);
  expect(touched.instances.filter((i) => !own.instances?.includes(i))).toEqual([]);
  // No route here starts a run: any instance created, whatever it names, is a finding.
  expect(touched.created).toEqual([]);
}

/** Whether `call` refused, by throwing or by rejecting. */
async function refused(call: () => unknown): Promise<boolean> {
  try {
    await call();
    return false;
  } catch {
    return true;
  }
}

/** IDs that try to reach `victim`'s storage through `id`: `:`, `/`, their user ID, their keys. */
const fuzz = (victim: Seeded, id: string) => [
  id,
  `${id}:`,
  `:${id}`,
  `${victim.id}:${id}`,
  `u:${victim.id}`,
  `u:${victim.id}:${id}`,
  `${id}/`,
  `../${id}`,
  `../../${victim.id}/attachments/${id}`,
  `${victim.id}/${id}`,
  `u/${victim.id}/attachments/${id}`,
  `u/${victim.id}/files/${id}`,
  `u/${victim.id}/task-outputs/${id}`,
  `wf-${victim.task}`,
  `${id}%2F`,
  `${id}\u0000`,
];

/** A body each write route would take from the item's owner, so a 404 isn't a 400. */
const BODIES: Record<string, (attacker: Seeded) => unknown> = {
  "PUT /api/conversations/:id/model": (a) => ({ provider: a.provider, model: "gpt-4o" }),
  "PUT /api/settings/providers/:id": () => ({
    providerId: "openai",
    baseUrl: BASE_URL,
    model: "gpt-4o-mini",
  }),
  "PUT /api/settings/tools/:name": () => ({ override: "never" }),
};

/** The routes that take an ID, from the route table, as isolation.test.ts reads it. */
const idRoutes = [
  ...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)),
].filter((r) => !PUBLIC_ROUTES.has(r) && r.includes("/:"));

/** The victim's ID a route's param names. */
function victimId(route: string, v: Seeded): string {
  if (route.includes("/conversations/")) return v.conversation;
  if (route.includes("/artifacts/")) return v.artifact;
  if (route.includes("/attachments/")) return v.attachment;
  if (route.includes("/sessions/")) return v.spareSession;
  if (route.includes("/providers/")) return v.provider;
  if (route.includes("/grants/")) return v.grant;
  if (route.includes("/tasks/")) return v.task;
  return v.memory; // a tool name: nothing of the victim's, so any ID will do
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, raw.TEST_MIGRATIONS);
});

let a: Seeded;
let b: Seeded;
beforeEach(async () => {
  ({ a, b } = await seedBoth());
  // A provider Test would call the provider: answer it here, so nothing leaves the test.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
});
afterEach(() => vi.restoreAllMocks());

describe("R2 keys, DO names and Workflow ids (AC2)", () => {
  it("B's fuzzed IDs on every ID route touch nothing of A's: no key, no DO, no instance", async () => {
    const before = await snapshot(a);
    const touched = record();
    for (const route of idRoutes) {
      const [method = "", path = ""] = route.split(" ");
      for (const id of fuzz(a, victimId(route, a))) {
        // Encoded, so `/` and `:` reach the handler as part of the ID; raw, so they reach the router.
        for (const value of [encodeURIComponent(id), id]) {
          const url = path.replace(/:(\w+)/, value);
          const res = await as(b, method, url, { body: BODIES[route]?.(b) });
          const text = await res.text();
          // The tool route takes a name, not an ID: setting B's own override is fine (200).
          const allowed = route === "PUT /api/settings/tools/:name" ? [200, 400, 404] : [400, 404];
          expect([route, id, allowed.includes(res.status)]).toEqual([route, id, true]);
          expect([route, id, leaked(a, text)]).toEqual([route, id, []]);
        }
      }
    }
    expect(leaked(a, JSON.stringify(touched.created))).toEqual([]);
    onlyOwn(touched, b);
    expect(await snapshot(a)).toEqual(before);
  });

  it("names the R2 key from the server's ID, whatever the upload's name, query or headers", async () => {
    const before = await snapshot(a);
    const touched = record();
    const target = `u/${a.id}/attachments/${a.attachment}`;
    const res = await as(b, "POST", `/api/attachments?id=${a.attachment}&key=${target}`, {
      raw: "overwrite?",
      headers: {
        "x-file-name": `../../${target}.txt`,
        "x-attachment-id": a.attachment,
        "content-type": "text/plain",
      },
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();
    expect(id).not.toBe(a.attachment);
    expect(touched.keys).toContain(`u/${b.id}/attachments/${id}`);
    // B's own content route reads B's key: the recorder sees real traffic, not silence.
    expect((await as(b, "GET", `/api/attachments/${b.attachment}`)).status).toBe(200);
    onlyOwn(touched, b);
    expect(await snapshot(a)).toEqual(before);
  });

  it("every repository key builder refuses a fuzzed ID or keeps it under the caller's prefix", async () => {
    const user = forUser(b);
    const touched = record();
    for (const id of fuzz(a, a.attachment).slice(1)) {
      for (const read of [
        () => user.attachments.getObject(id),
        () => user.stepOutputs.get(id),
        () => user.stepOutputs.put(id, "x"),
        () => user.getFile(id),
        () => user.exports.key(id),
      ]) {
        // Refused, or a key the recorder checks: a well-formed ID is just a missing key of B's.
        const key = await Promise.resolve()
          .then(read)
          .catch(() => null);
        if (typeof key === "string") touched.keys.push(key);
      }
      // A staged file's name is flattened into the export's own directory.
      const staged = user.exports.stagedKey(b.task, id);
      expect(staged.startsWith(`u/${b.id}/exports/${b.task}/staged/`), staged).toBe(true);
      expect(staged.split("/").includes(".."), staged).toBe(false);
    }
    // The full-key readers take only the caller's own prefix.
    const theirs = `u/${a.id}/attachments/${a.attachment}`;
    // R2 keys are opaque: `u/<B>/../<A>` is a key under B's prefix, never a path into A's.
    for (const key of [theirs, `u/${a.id}/`, `u/${b.id}`, "u/", ""]) {
      expect([key, await refused(() => user.exports.getObject(key))]).toEqual([key, true]);
      expect([key, await refused(() => user.exports.listPrefix(key))]).toEqual([key, true]);
    }
    onlyOwn(touched, b);
  });

  it("mints a DO's user only from the exact `u:<id>` name the server sets", () => {
    expect(scopeForAssistant(`u:${a.id}`).userId).toBe(a.id);
    for (const name of [
      a.id,
      `U:${a.id}`,
      ` u:${a.id}`,
      `u:${a.id} `,
      `u:${a.id}\n`,
      `u: ${a.id}`,
      `u:`,
      `x:u:${a.id}`,
    ]) {
      let minted: string | undefined;
      try {
        minted = scopeForAssistant(name).userId;
      } catch {}
      expect([name, minted]).toEqual([name, undefined]);
    }
    // Anything after `u:` is the whole user ID: `u:<B>:<A>` names neither of them.
    expect(scopeForAssistant(`u:${b.id}:${a.id}`).userId).not.toBe(a.id);
  });

  it("opens B's own assistant whatever the socket request names", async () => {
    const touched = record();
    const upgrade = { upgrade: "websocket", "x-partykit-room": `u:${a.id}` };
    for (const path of [
      `/api/chat?name=u:${a.id}&_pk=${a.id}`,
      `/api/chat?room=${encodeURIComponent(`u:${a.id}`)}`,
      `/api/chat/${encodeURIComponent(`u:${a.id}`)}`,
      `/agents/assistant/u:${a.id}`,
      `/parties/assistant/u:${a.id}`,
    ]) {
      const res = await as(b, "GET", path, { headers: upgrade });
      res.webSocket?.accept();
      res.webSocket?.close();
      expect([path, [101, 404].includes(res.status)]).toEqual([path, true]);
    }
    // The spending routes reach the assistant too, over RPC.
    expect((await as(b, "GET", `/api/settings/spending?user=u:${a.id}`)).status).toBe(200);
    expect(touched.names).toContain(`u:${b.id}`);
    onlyOwn(touched, b);
  });

  it("Workflow instance ids: one row each, matched exactly, and the row's user is the authority", async () => {
    const user = forUser(b);
    const theirs = `wf-${a.task}`;
    // B can't claim A's instance with a row of their own.
    await expect(
      user.tasks.create({
        id: crypto.randomUUID(),
        conversationId: b.conversation,
        workflowInstanceId: theirs,
        kind: "turn",
        mode: "background",
      }),
    ).rejects.toThrow();
    for (const id of fuzz(a, theirs).filter((id) => id !== theirs)) {
      expect([id, await repo.scopeForTask(id)]).toEqual([id, null]);
    }
    // An instance id that names A, with `:` and `/`, still mints the user whose row holds it.
    const steered = `u:${a.id}/wf-${a.task}:${a.id}`;
    expect(
      await user.tasks.create({
        id: crypto.randomUUID(),
        conversationId: b.conversation,
        workflowInstanceId: steered,
        kind: "turn",
        mode: "background",
      }),
    ).toBe(true);
    expect((await repo.scopeForTask(steered))?.scope.userId).toBe(b.id);
    expect((await repo.scopeForTask(theirs))?.scope.userId).toBe(a.id);
  });
});

describe("recall (AC3)", () => {
  /** Near-duplicates of one fact: the same words, a word or a letter apart. */
  const variants = (who: string) => [
    `My dentist appointment is on Tuesday at 9 with Dr Rivera (${who})`,
    `my dentist appointment is on tuesday at 9 with dr rivera`,
    `My dentist appointment is on Tuesday at 10 with Dr Rivera`,
    `Dentist appointment Tuesday 9 Dr Rivera`,
    `My dentists appointment is on Tuesday at 9 with Dr Riviera`,
  ];

  it("B's recall, search and recall tool never return A's memories, however close", async () => {
    const user = { via: "user" } as const;
    const from = { source: "memory_screen" } as const;
    const memory = { a: forUser(a).memory, b: forUser(b).memory };
    // A has more matches than one recall reads as candidates, all ranked above B's single one.
    for (let i = 0; i < 120; i += 1) {
      for (const text of variants(`A ${a.id} #${i}`))
        await memory.a.create(user, text, "fact", from);
    }
    await memory.b.create(user, "My dentist appointment is on Tuesday (B)", "fact", from);
    const theirs = new Set(
      (
        await env.DB.prepare("SELECT id FROM memories WHERE user_id = ?").bind(a.id).all<{
          id: string;
        }>()
      ).results.map((r) => r.id),
    );
    expect(theirs.size).toBeGreaterThan(500);
    const queries = [...variants(`A ${a.id} #0`), "dentist", "Rivera", a.id, a.memory, "*"];
    const tools = new Map(
      memoryTools(memory.b, () => ({
        tainted: false,
        userAsserted: false,
        source: { source: "chat" },
      })).map((t: MemoryTool) => [t.manifest.name, t]),
    );
    for (const query of queries) {
      const recalled = await memory.b.recall(query, { budget: 100_000, limit: 25 });
      const searched = await memory.b.search(query, 100);
      const ids = [...recalled.memories, ...searched].map((m) => m.id);
      expect([query, ids.filter((id) => theirs.has(id))]).toEqual([query, []]);
      expect([...recalled.memories, ...searched].every((m) => m.userId === b.id)).toBe(true);
      const tool = await tools
        .get("recall")
        ?.execute({ query, limit: 25 }, new AbortController().signal);
      const text = JSON.stringify(tool);
      // The tool echoes an unmatched query back, so a query that is one of A's IDs is no leak.
      const named = [...theirs].filter((id) => id !== query && text.includes(id));
      expect([query, named]).toEqual([query, []]);
    }
    // B does find their own near-duplicate, past A's hundreds of better matches.
    const own = await memory.b.recall("dentist appointment Tuesday");
    expect(own.memories.map((m) => m.text)).toContain("My dentist appointment is on Tuesday (B)");
    // And B's forget can't reach one of A's, as an inferred ask (a proposal) or the user's own
    // (a delete). The service ran and found nothing: not the tool's empty-ids refusal.
    const signal = new AbortController().signal;
    const forgetAs = (userAsserted: boolean) =>
      memoryTools(memory.b, () => ({
        tainted: false,
        userAsserted,
        source: { source: "chat" },
      })).find((t) => t.manifest.name === "forget");
    for (const userAsserted of [false, true]) {
      for (const ids of [[a.memory], [b.memory, a.memory]]) {
        const out = await forgetAs(userAsserted)?.execute({ ids }, signal);
        expect([userAsserted, ids, out?.ok, out?.content]).toEqual([
          userAsserted,
          ids,
          false,
          "I can't find that memory — it may already be gone.",
        ]);
      }
      expect(await forUser(a).memory.get(a.memory)).toBeTruthy();
      expect(await forUser(b).memory.get(b.memory)).toBeTruthy();
    }
    // The same call reaches B's own memory: the refusal above is the user filter, not the call.
    const mine = await forgetAs(true)?.execute({ ids: [b.memory] }, signal);
    expect([mine?.ok, mine?.content]).toEqual([
      true,
      "Forgotten — that memory and its earlier versions are gone.",
    ]);
    expect(await forUser(b).memory.get(b.memory)).toBeFalsy();
    expect(await forUser(a).memory.get(a.memory)).toBeTruthy();
  });
});

describe("credentials and tasks (AC4)", () => {
  it("B's turns resolve B's own key, never A's, whatever the pick names", async () => {
    const composed = await bindings;
    const scope = scopeOf(b);
    for (const pick of [
      { provider: a.provider },
      { provider: a.provider, model: "gpt-4o" },
      { provider: `${a.provider}:` },
      { provider: `u:${a.id}/${a.provider}` },
    ]) {
      expect([pick, await resolveChatModel(composed, scope, "chat", pick)]).toEqual([
        pick,
        { error: "no_model" },
      ]);
    }
    // A's conversation reads as missing, so the pick falls back to B's own Chat role.
    for (const pick of [
      { conversationId: a.conversation },
      { role: "chat" as const },
      { role: "background" as const },
    ]) {
      const picked = await resolveChatModel(composed, scope, "task", pick);
      expect(["apiKey" in picked && picked.apiKey, pick]).toEqual([b.apiKey, pick]);
    }
    // The vault itself opens A's secret for A's scope only.
    if (!composed.VAULT) throw new Error("the harness has a vault");
    const ref = {
      secretId: a.secret,
      purpose: "model_api_key",
      binding: credentialBinding("openai", BASE_URL),
      caller: "isolation",
    } as const;
    const vaultScope = scope as unknown as Parameters<typeof decrypt>[1];
    await expect(decrypt(composed.VAULT, vaultScope, ref)).rejects.toThrow();
  });

  it("B can't read, cancel, resume, finish or rewrite A's task, through a route or the repository", async () => {
    const before = await snapshot(a);
    const touched = record();
    const user = forUser(b);
    for (const id of fuzz(a, a.task)) {
      expect(await user.tasks.get(id)).toBeUndefined();
      expect(await user.tasks.cancel(id)).toBe(false);
      expect(await user.tasks.resume(id)).toBe(false);
      expect(await user.tasks.finish(id, "failed", "B")).toBe(false);
      expect(await user.tasks.saveState(id, "{}", "running")).toBe(false);
      expect(await user.tasks.markRunning(id, Date.now())).toBeUndefined();
      for (const action of ["continue", "stop"]) {
        const res = await as(b, "POST", `/api/tasks/${encodeURIComponent(id)}/${action}`, {
          body: {},
        });
        expect([id, action, res.status]).toEqual([id, action, 404]);
      }
    }
    // B owns two tasks here: its own, and the approval fixture the helper seeds for it.
    // Either way nothing of A's may leak in.
    const listed = (await user.tasks.list()).map((t) => t.id);
    expect(listed).toHaveLength(2);
    expect(listed).toContain(b.task);
    expect(listed).not.toContain(a.task);
    // No Workflow of A's was woken or created, and A's paused task is as it was.
    expect(leaked(a, JSON.stringify(touched.created))).toEqual([]);
    onlyOwn(touched, b);
    expect(await snapshot(a)).toEqual(before);
  });

  it("a Workflow step acts only as its task row's user, whatever its instance id names", async () => {
    const owner = forUser(a);
    const taskId = crypto.randomUUID();
    // The instance id names B, with `:` and `/`: it is data, and A's row is the authority.
    const instanceId = `u:${b.id}/wf-${b.task}:${b.conversation}`;
    const state = newTaskTurnState([{ role: "user", content: "hello" }], `turn-${taskId}`);
    await owner.tasks.create({
      id: taskId,
      conversationId: a.conversation,
      workflowInstanceId: instanceId,
      kind: "turn",
      mode: "background",
      state: JSON.stringify(state),
    });
    const before = await snapshot(b);
    const touched = record();
    const scopes: UserScope[] = [];
    const provider: ModelProvider = {
      id: "scripted",
      listModels: async () => [],
      capabilities: () => ({ tools: false, usageInStream: true }),
      async *stream(): AsyncGenerator<ModelEvent> {
        yield { type: "text.delta", text: "done" };
        const usage = { inputTokens: 3, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };
        yield { type: "usage", usage };
        yield { type: "done", finishReason: "stop" };
      },
    };
    const persisted = new Map<string, unknown>();
    const stepper: TaskStepper = {
      do: async (name, _config, fn) => {
        const value = await fn();
        persisted.set(name, value);
        return value;
      },
      sleep: async () => {},
      waitForEvent: async () => ({ payload: { userId: b.id, taskId: b.task } as never }),
    };
    const resolveModel = async (_env: unknown, scope: UserScope) => {
      scopes.push(scope);
      return { provider, model: "gpt-4o", apiKey: a.apiKey, billingId: "openai" };
    };
    await executeTask(
      raw,
      await compose(raw),
      { resolveModel: resolveModel as never, taskTools: [] },
      instanceId,
      stepper,
    );
    expect((await owner.tasks.get(taskId))?.status).toBe("succeeded");
    expect(scopes.map((s) => s.userId)).toEqual([a.id]);
    onlyOwn(touched, a);
    expect(await snapshot(b)).toEqual(before);
  });

  it("the real Workflow engine takes the user from the row, not from params naming B", async () => {
    const owner = forUser(a);
    const taskId = crypto.randomUUID();
    const instanceId = `iso-${taskId}`;
    await owner.tasks.create({
      id: taskId,
      conversationId: a.conversation,
      workflowInstanceId: instanceId,
      kind: "turn",
      mode: "background",
      state: "not json", // fails before any model is needed
    });
    const before = await snapshot(b);
    const params = { taskId: b.task, userId: b.id, conversationId: b.conversation };
    const touched = record();
    await raw.TASK_WORKFLOW.create({ id: instanceId, params });
    // The recorder sees a creation: an empty `created` elsewhere is real silence.
    expect(touched.created).toEqual([{ id: instanceId, params }]);
    await vi.waitFor(async () => expect((await owner.tasks.get(taskId))?.status).toBe("failed"), {
      timeout: 10_000,
      interval: 100,
    });
    expect(await snapshot(b)).toEqual(before);
  });
});
