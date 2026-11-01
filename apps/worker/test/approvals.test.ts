// SPDX-License-Identifier: Apache-2.0
// The approvals routes (M3-07 AC2-AC5, AC10, AC11): approve, deny and the per-approval passkey
// step-up over HTTP, never the socket; the batch is checked against D1 and the session before
// anything is recorded or resumed. Includes the M3-21a isolation cases for these routes.
import { runInDurableObject } from "cloudflare:test";
import type { HarnessEvent, ModelEvent, ModelProvider } from "@opa/core";
import { createRepository, scopeFromSession } from "@opa/db/repository";
import type { LoopTool } from "@opa/harness-builtin";
import { type RiskClass, ToolRegistry } from "@opa/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Assistant } from "../src/assistant";
import { workerApp } from "../src/worker-app";
import {
  type Browser,
  claim,
  count,
  db,
  env,
  freshDatabase,
  ORIGIN,
  SOCKET_WAIT,
  sessionHeaders,
} from "./helpers/app";

freshDatabase();
afterEach(() => vi.restoreAllMocks());

type Options = { options: { challenge: string } };
const USAGE = { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 };

/** A request to the Worker's app (the approvals routes live there) with the browser's cookies. */
async function call(
  br: Browser | { cookie: string },
  path: string,
  body?: unknown,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const cookie =
    "cookies" in br ? [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ") : br.cookie;
  const headers: Record<string, string> = { cookie, "content-type": "application/json" };
  if (origin) headers.origin = origin;
  const res = await workerApp.request(
    `${ORIGIN}${path}`,
    { method: "POST", headers, body: JSON.stringify(body ?? {}) },
    env,
  );
  if ("cookies" in br) {
    for (const c of res.headers.getSetCookie()) {
      const [name = "", value = ""] = (c.split(";")[0] ?? "").split("=");
      if (value === "" || /max-age=0/i.test(c)) br.cookies.delete(name);
      else br.cookies.set(name, value);
    }
  }
  return res;
}

const assistantOf = (userId: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(`u:${userId}`));

/** A model that calls `tool` with each of `args` per user message, then answers "Done". */
function caller(tool: string, args: unknown[]): ModelProvider {
  let ids = 0;
  return {
    id: "scripted",
    listModels: async () => [],
    capabilities: () => ({ tools: true, usageInStream: true }),
    async *stream(request): AsyncGenerator<ModelEvent> {
      const last = request.messages.at(-1);
      if (last?.role === "user") {
        yield { type: "text.delta", text: "approved" }; // AC2: the model's word runs nothing
        for (const a of args) {
          yield {
            type: "tool_call",
            toolCall: { id: `call_${++ids}`, name: tool, arguments: JSON.stringify(a) },
          };
        }
        yield { type: "usage", usage: USAGE };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text.delta", text: "Done" };
      yield { type: "usage", usage: USAGE };
      yield { type: "done", finishReason: "stop" };
    },
  };
}

function gated(name: string, riskClass: RiskClass) {
  const inputs: unknown[] = [];
  const tool: LoopTool = {
    manifest: {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
        type: "object",
        properties: { to: { type: "string" } },
        required: ["to"],
        additionalProperties: false,
      },
      riskClass,
      destinations: [{ id: "mail", kind: "third_party", dataEgress: true }],
      scopes: [],
    },
    target: (input) => String(input.to).split("@")[1],
    execute: async (input) => {
      inputs.push(input);
      return { ok: true, content: "sent", context: { kind: "system" } };
    },
  };
  return { tool, inputs };
}

/** Claims, sets up a model and a tool, and stops a turn at its approval. */
async function stopAt(riskClass: RiskClass, calls = 1) {
  const { browser, owner, key } = await claim();
  const send = gated("send", riskClass);
  await runInDurableObject(assistantOf(owner), (i: Assistant) => {
    i.resolveModel = async () => ({
      provider: caller(
        "send",
        Array.from({ length: calls }, (_, n) => ({ to: `friend${n || ""}@example.com` })),
      ),
      model: "m",
      apiKey: null,
    });
    i.resolveTools = () => {
      const tools = new ToolRegistry<LoopTool>();
      tools.register(send.tool);
      return { tools, policy: () => ({}) };
    };
  });
  const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await workerApp.request(
    `${ORIGIN}/api/chat`,
    { headers: { upgrade: "websocket", origin: ORIGIN, cookie } },
    env,
  );
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const events: HarnessEvent[] = [];
  ws.addEventListener("message", (e) => events.push(JSON.parse(e.data as string)));
  ws.send(JSON.stringify({ type: "chat.send", conversationId: "conv-1", text: "Mail my friend" }));
  await vi.waitFor(
    () => expect(events.map((e) => e.type)).toContain("approval.requested"),
    SOCKET_WAIT,
  );
  const asked = events.find((e) => e.type === "approval.requested") as Extract<
    HarnessEvent,
    { type: "approval.requested" }
  >;
  const { batchId } = asked.payload;
  const approvalId = asked.payload.items[0]?.approvalId as string;
  const ids = asked.payload.items.map((i) => i.approvalId);
  const done = () =>
    vi.waitFor(() => expect(events.map((e) => e.type)).toContain("turn.completed"), SOCKET_WAIT);
  return { browser, owner, key, send, batchId, approvalId, ids, events, ws, done };
}

const rowStatus = (batchId: string) =>
  db.prepare("SELECT status FROM approvals WHERE batch_id = ?").bind(batchId).first("status");
const audits = (action: string, result = "ok") =>
  count("audit_log", `action = '${action}' AND result = '${result}'`);

describe("approve and deny (M3-07 AC10)", () => {
  it("approves over POST: the decision lands in D1, then the turn resumes and the call runs", async () => {
    const { browser, send, batchId, approvalId, done } = await stopAt("consequential");
    expect(send.inputs).toEqual([]); // the model said "approved"; nothing ran (AC2)
    const res = await call(browser, `/api/approvals/${batchId}`, {
      decisions: [{ approvalId, decision: "approve", scope: "once" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "resumed" });
    await done();
    expect(send.inputs).toEqual([{ to: "friend@example.com" }]);
    expect(await rowStatus(batchId)).toBe("executed");
    expect(await audits("approval.approve")).toBe(1);
    // A second POST, a retry or another tab, decides nothing.
    const again = await call(browser, `/api/approvals/${batchId}`, {
      decisions: [{ approvalId, decision: "approve", scope: "once" }],
    });
    expect(again.status).toBe(409);
    expect(send.inputs).toHaveLength(1);
  });

  it("denies: the call never runs and the model is told so", async () => {
    const { browser, send, batchId, approvalId, done, events } = await stopAt("consequential");
    const res = await call(browser, `/api/approvals/${batchId}`, {
      decisions: [{ approvalId, decision: "deny" }],
    });
    expect(res.status).toBe(200);
    await done();
    expect(send.inputs).toEqual([]);
    expect(await rowStatus(batchId)).toBe("denied");
    expect(await audits("approval.deny")).toBe(1);
    const results = events.filter((e) => e.type === "tool.result");
    expect(results.at(-1)).toMatchObject({ payload: { error: "The user denied this call." } });
  });

  it("creates a standing grant for an hour's scope from an untainted context (AC3)", async () => {
    const { browser, batchId, approvalId, done } = await stopAt("consequential");
    const res = await call(browser, `/api/approvals/${batchId}`, {
      decisions: [{ approvalId, decision: "approve", scope: "hour" }],
    });
    expect(res.status).toBe(200);
    await done();
    expect(await count("grants", "tool = 'send' AND scope = 'hour'")).toBe(1);
  });

  it("refuses an incomplete, duplicated or out-of-scope decision before touching anything", async () => {
    const { browser, send, batchId, approvalId } = await stopAt("consequential");
    for (const decisions of [
      [],
      [{ approvalId: "appr_nope", decision: "approve" }],
      [
        { approvalId, decision: "approve" },
        { approvalId, decision: "deny" },
      ],
      [{ approvalId, decision: "approve", scope: "forever" }],
      [{ approvalId, decision: "maybe" }],
    ]) {
      const res = await call(browser, `/api/approvals/${batchId}`, { decisions });
      expect(res.status, JSON.stringify(decisions)).toBe(400);
    }
    expect(await rowStatus(batchId)).toBe("pending");
    expect(send.inputs).toEqual([]);
    // Each refusal is in the audit log.
    const refused = `action = 'approval.decide' AND result = 'denied' AND target_id = '${batchId}'`;
    expect(await count("audit_log", refused)).toBe(5);
  });

  it("takes decisions only from this exact origin with a session, never a socket frame", async () => {
    const { browser, send, batchId, approvalId, ws } = await stopAt("consequential");
    const body = { decisions: [{ approvalId, decision: "approve" }] };
    expect((await call(browser, `/api/approvals/${batchId}`, body, null)).status).toBe(403);
    const evil = "https://evil.opa.test";
    expect((await call(browser, `/api/approvals/${batchId}`, body, evil)).status).toBe(403);
    expect((await call({ cookie: "" }, `/api/approvals/${batchId}`, body)).status).toBe(401);
    // A frame that names the batch is ignored by the assistant.
    ws.send(JSON.stringify({ type: "approval.decide", batchId, ...body }));
    ws.send(JSON.stringify({ type: "approval.resolved", payload: { batchId, ...body } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await rowStatus(batchId)).toBe("pending");
    expect(send.inputs).toEqual([]);
  });

  it("refuses a decision for a cancelled task before recording or forwarding it", async () => {
    const { browser, owner } = await claim();
    await db.batch([
      db.prepare("INSERT INTO conversations (id, user_id) VALUES ('c-task', ?)").bind(owner),
      db
        .prepare(
          "INSERT INTO tasks (id, user_id, conversation_id, workflow_instance_id, kind, mode, status, finished_at) VALUES ('t1', ?, 'c-task', 'inst-1', 'turn', 'background', 'cancelled', 1)",
        )
        .bind(owner),
      db
        .prepare(
          `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, task_id, tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at)
           VALUES ('batch_t', 'appr_c1', 0, ?, 'c-task', 't1', 'send', 'c1', 'consequential', 'default_consequential', 0, '["once"]', '{}', 'h', ?)`,
        )
        .bind(owner, Date.now() + 60_000),
    ]);
    const res = await call(browser, "/api/approvals/batch_t", {
      decisions: [{ approvalId: "appr_c1", decision: "approve" }],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "task_cancelled" });
    expect(await rowStatus("batch_t")).toBe("pending");
  });
});

/** `GET /api/approvals`, as the Inbox reads it. */
async function pending(br: Browser | { cookie: string }) {
  const cookie =
    "cookies" in br ? [...br.cookies].map(([k, v]) => `${k}=${v}`).join("; ") : br.cookie;
  return workerApp.request(`${ORIGIN}/api/approvals?status=pending`, { headers: { cookie } }, env);
}

describe("the pending list (M3-07 AC8)", () => {
  it("lists a stopped turn's batch as its card shows it, and drops it once decided", async () => {
    const { browser, batchId, approvalId, done } = await stopAt("consequential");
    const res = await pending(browser);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { batches } = await res.json<{ batches: Record<string, unknown>[] }>();
    expect(batches).toEqual([
      {
        batchId,
        conversationId: "conv-1",
        conversationTitle: "Mail my friend",
        taskId: null,
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
        items: [
          {
            approvalId,
            tool: "send",
            args: '{"to":"friend@example.com"}',
            target: "example.com",
            risk: "consequential",
            rule: "default_consequential",
            scopes: ["once", "hour", "destination"],
            expiresAt: expect.any(Number),
          },
        ],
      },
    ]);
    // Nothing that binds or steps up leaves the server.
    expect(JSON.stringify(batches)).not.toMatch(/nonce|bindingHash|binding_hash|canonical/);
    await call(browser, `/api/approvals/${batchId}`, {
      decisions: [{ approvalId, decision: "deny" }],
    });
    await done();
    expect(await (await pending(browser)).json()).toEqual({ batches: [] });
  });

  it("keeps a multi-action batch together, in its stored order", async () => {
    const { browser, batchId, ids } = await stopAt("consequential", 3);
    const { batches } = await (await pending(browser)).json<{
      batches: { batchId: string; items: { approvalId: string }[] }[];
    }>();
    expect(batches.map((b) => b.batchId)).toEqual([batchId]);
    expect(batches[0]?.items.map((i) => i.approvalId)).toEqual(ids);
  });

  it("leaves out expired items and a cancelled task's", async () => {
    const { browser, owner } = await claim();
    const insert = (batch: string, task: string | null, expiresAt: number) =>
      db
        .prepare(
          `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id, task_id, tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at)
           VALUES (?, ?, 0, ?, 'c-task', ?, ?, 'send', 'c1', 'consequential', 'default_consequential', 0, '["once"]', '{}', 'h', ?)`,
        )
        .bind(batch, `appr_${batch}`, owner, task ? null : "turn-1", task, expiresAt);
    await db.batch([
      db.prepare("INSERT INTO conversations (id, user_id) VALUES ('c-task', ?)").bind(owner),
      db
        .prepare(
          "INSERT INTO tasks (id, user_id, conversation_id, workflow_instance_id, kind, mode, status, finished_at) VALUES ('t1', ?, 'c-task', 'inst-1', 'turn', 'background', 'cancelled', 1)",
        )
        .bind(owner),
      insert("b_cancelled", "t1", Date.now() + 60_000),
      insert("b_expired", null, Date.now() - 1),
      insert("b_live", null, Date.now() + 60_000),
    ]);
    const { batches } = await (await pending(browser)).json<{ batches: { batchId: string }[] }>();
    expect(batches.map((b) => b.batchId)).toEqual(["b_live"]);
  });

  it("still lists the rest when a row's taint or scopes can't be read, and keeps it careful", async () => {
    const { browser, owner } = await claim();
    const insert = (batch: string, taint: string | null, scopes: string) =>
      db
        .prepare(
          `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id, tool, tool_call_id, risk, rule, step_up, scopes, taint, canonical, binding_hash, expires_at)
           VALUES (?, ?, 0, ?, 'c-bad', 'turn-1', 'send', 'c1', 'consequential', 'default_consequential', 0, ?, ?, '{}', 'h', ?)`,
        )
        .bind(batch, `appr_${batch}`, owner, scopes, taint, Date.now() + 60_000);
    await db.batch([
      db.prepare("INSERT INTO conversations (id, user_id) VALUES ('c-bad', ?)").bind(owner),
      insert("b_bad", "{not json", "not json"),
      insert("b_good", null, '["once","hour"]'),
    ]);
    const { batches } = await (await pending(browser)).json<{
      batches: { batchId: string; items: { taint?: unknown; scopes: string[] }[] }[];
    }>();
    const items = Object.fromEntries(batches.map((b) => [b.batchId, b.items[0]]));
    expect(items.b_good).toMatchObject({ scopes: ["once", "hour"] });
    expect(items.b_good?.taint).toBeUndefined();
    expect(items.b_bad).toMatchObject({
      scopes: ["once"],
      taint: { kind: "tool", label: "a source I couldn't read" },
    });
  });

  it("limits by batch, never cutting one, and keeps a batch's items in their stored order", async () => {
    const { owner } = await claim();
    const now = Date.now();
    // Position 0 expires after position 1: the order is still the stored one.
    const insert = (batch: string, position: number, expiresAt: number) =>
      db
        .prepare(
          `INSERT INTO approvals (batch_id, approval_id, position, user_id, conversation_id, turn_id, tool, tool_call_id, risk, rule, step_up, scopes, canonical, binding_hash, expires_at)
           VALUES (?, ?, ?, ?, 'c-order', 'turn-1', 'send', ?, 'consequential', 'default_consequential', 0, '["once"]', '{}', 'h', ?)`,
        )
        .bind(batch, `appr_${batch}_${position}`, position, owner, `c${position}`, expiresAt);
    await db.batch([
      db.prepare("INSERT INTO conversations (id, user_id) VALUES ('c-order', ?)").bind(owner),
      insert("b_soon", 0, now + 120_000),
      insert("b_soon", 1, now + 60_000),
      insert("b_soon", 2, now + 90_000),
      insert("b_later", 0, now + 300_000),
    ]);
    const user = createRepository(env).forUser(scopeFromSession({ userId: owner }));
    const one = await user.approvals.pending(now, 1);
    expect(one.map(({ row }) => row.approvalId)).toEqual([
      "appr_b_soon_0",
      "appr_b_soon_1",
      "appr_b_soon_2",
    ]);
    expect((await user.approvals.pending(now)).map(({ row }) => row.batchId)).toEqual([
      "b_soon",
      "b_soon",
      "b_soon",
      "b_later",
    ]);
  });

  it("answers only for the session's user, and only with a session", async () => {
    await stopAt("consequential");
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('b', 'B', 'member')")
      .run();
    expect(await (await pending(await sessionHeaders("b"))).json()).toEqual({ batches: [] });
    expect((await pending({ cookie: "" })).status).toBe(401);
  });
});

describe("isolation (M3-21a cases for the approvals routes)", () => {
  it("answers 404 for another user's batch on every route and changes nothing", async () => {
    const { send, batchId, approvalId } = await stopAt("irreversible");
    await db
      .prepare("INSERT INTO users (id, display_name, role) VALUES ('b', 'B', 'member')")
      .run();
    const bob = await sessionHeaders("b");
    const before = await db.prepare("SELECT * FROM approvals").all();
    const decisions = [{ approvalId, decision: "approve", scope: "once" }];
    for (const path of [`/api/approvals/${batchId}`, `/api/approvals/${batchId}/options`]) {
      const res = await call(bob, path, { decisions });
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect((await db.prepare("SELECT * FROM approvals").all()).results).toEqual(before.results);
    expect(send.inputs).toEqual([]);
    // A malformed ID is a 404 too, before it reaches a query.
    expect((await call(bob, "/api/approvals/..%2Fx", { decisions })).status).toBe(404);
  });
});

describe("the per-approval step-up (M3-07 AC4, AC11)", () => {
  async function options(br: Browser, batchId: string, decisions: unknown[]) {
    const res = await call(br, `/api/approvals/${batchId}/options`, { decisions });
    expect(res.status).toBe(200);
    return (await res.json<Options>()).options;
  }

  it("approves an irreversible call only with a passkey over the batch's challenge", async () => {
    const { browser, key, send, batchId, approvalId, done } = await stopAt("irreversible");
    const decisions = [{ approvalId, decision: "approve", scope: "once" }];
    const opts = await options(browser, batchId, decisions);
    // The nonce never leaves the server: the options carry only the derived challenge.
    const nonce = await db
      .prepare("SELECT nonce FROM approvals WHERE batch_id = ?")
      .bind(batchId)
      .first<string>("nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(opts)).not.toContain(nonce);
    const credential = await key.get(opts);
    const res = await call(browser, `/api/approvals/${batchId}`, { decisions, credential });
    expect(res.status).toBe(200);
    await done();
    expect(send.inputs).toHaveLength(1);
    expect(await audits("approval.step_up")).toBe(1);
    // D2: signing an approval doesn't open the account step-up window.
    const stamp = await db.prepare("SELECT step_up_at FROM sessions").first("step_up_at");
    expect(stamp).toBeNull();
    // The ceremony is burned with the decision.
    expect(await count("approvals", "nonce IS NOT NULL")).toBe(0);
  });

  it("refuses without the assertion, even right after an account step-up or a login (D1)", async () => {
    const { browser, key, send, batchId, approvalId } = await stopAt("irreversible");
    // A fresh account step-up: the window M3-02 AC7 uses. It doesn't count here.
    const so = await call(browser, "/api/auth/step-up/session/options", {});
    const { options: stepOpts } = await so.json<Options>();
    const stepped = await call(browser, "/api/auth/step-up/session", {
      credential: await key.get(stepOpts),
    });
    expect(stepped.status).toBe(200);
    const decisions = [{ approvalId, decision: "approve", scope: "once" }];
    const res = await call(browser, `/api/approvals/${batchId}`, { decisions });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "assertion_required" });
    // An assertion over a login challenge isn't one for this batch either.
    const lo = await call(browser, "/api/auth/login/options", {});
    const { options: loginOpts } = await lo.json<Options>();
    await options(browser, batchId, decisions);
    const relayed = await call(browser, `/api/approvals/${batchId}`, {
      decisions,
      credential: await key.get(loginOpts),
    });
    expect(relayed.status).toBe(403);
    expect(await rowStatus(batchId)).toBe("pending");
    expect(send.inputs).toEqual([]);
    expect(await audits("approval.step_up", "denied")).toBe(2);
  });

  it("refuses a flipped decision, a reordering and a replayed assertion (W3, W5)", async () => {
    const { browser, key, send, batchId, ids, done } = await stopAt("irreversible", 2);
    const [a, b] = ids as [string, string];
    const signed = [
      { approvalId: a, decision: "approve", scope: "once" },
      { approvalId: b, decision: "deny", scope: "once" },
    ];
    const credential = await key.get(await options(browser, batchId, signed));
    // Signed "approve A, deny B"; submitted "approve both": another digest. The attempt burns
    // the ceremony, so the honest submission with the same assertion fails too.
    const flipped = await call(browser, `/api/approvals/${batchId}`, {
      decisions: [signed[0], { ...signed[1], decision: "approve" }],
      credential,
    });
    expect(flipped.status).toBe(403);
    expect(await flipped.json()).toEqual({ error: "decisions_changed" });
    const replayed = await call(browser, `/api/approvals/${batchId}`, {
      decisions: signed,
      credential,
    });
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toEqual({ error: "no_challenge" });
    // The submitted order doesn't matter; the batch's stored order is what is signed.
    const fresh = await key.get(await options(browser, batchId, [signed[1], signed[0]]));
    const ok = await call(browser, `/api/approvals/${batchId}`, {
      decisions: signed,
      credential: fresh,
    });
    expect(ok.status).toBe(200);
    await done();
    expect(send.inputs).toEqual([{ to: "friend@example.com" }]);
    // A replay after the decision finds the batch decided.
    const again = await call(browser, `/api/approvals/${batchId}`, {
      decisions: signed,
      credential: fresh,
    });
    expect(again.status).toBe(409);
  });

  it("refuses an assertion for another batch, or from a session that didn't ask (W4, W5)", async () => {
    const { browser, key, send, batchId, approvalId } = await stopAt("irreversible");
    const decisions = [{ approvalId, decision: "approve", scope: "once" }];
    // Signed in this session; another session of the same user submits it (W4: the
    // ceremony is bound to the session that asked for it).
    const credential = await key.get(await options(browser, batchId, decisions));
    const owner = (await db.prepare("SELECT id FROM users").first<string>("id")) as string;
    const other = await sessionHeaders(owner);
    const stolen = await call(other, `/api/approvals/${batchId}`, { decisions, credential });
    expect(stolen.status).toBe(403);
    expect(await stolen.json()).toEqual({ error: "no_challenge" });
    // The failed attempt burned it: the right session can't use that assertion either.
    const late = await call(browser, `/api/approvals/${batchId}`, { decisions, credential });
    expect(late.status).toBe(403);
    expect(await rowStatus(batchId)).toBe("pending");
    expect(send.inputs).toEqual([]);
  });

  it("refuses a bad signature, and needs no step-up to deny (W4)", async () => {
    const { browser, key, send, batchId, approvalId } = await stopAt("irreversible");
    const approve = [{ approvalId, decision: "approve", scope: "once" }];
    const denyOpts = await call(browser, `/api/approvals/${batchId}/options`, {
      decisions: [{ approvalId, decision: "deny" }],
    });
    expect(denyOpts.status).toBe(400); // a deny needs no ceremony
    const credential = await key.get(await options(browser, batchId, approve));
    const res = await call(browser, `/api/approvals/${batchId}`, {
      decisions: approve,
      credential: { ...credential, response: { ...credential.response, signature: "AAAA" } },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_verified" });
    expect(send.inputs).toEqual([]);
    const deny = await call(browser, `/api/approvals/${batchId}`, {
      decisions: [{ approvalId, decision: "deny" }],
    });
    expect(deny.status).toBe(200);
    expect(await rowStatus(batchId)).toBe("denied");
  });
});
