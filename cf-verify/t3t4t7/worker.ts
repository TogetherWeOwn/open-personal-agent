// SPDX-License-Identifier: Apache-2.0
// Fixture Worker for the owner-approved T3/T4/T7 cf-verify window (TWO-669, plan TWO-573).
// Three deterministic stubs on synthetic data: a Workflow with named steps and a D1 dedupe
// ledger (T3), a hibernating WebSocket DO that replays numbered events (T4), and an AI-binding
// proxy that only dispatches to the approved stub registry (T7). No product code, no live tools.
import { DurableObject, WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";

export interface FixtureEnv {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  VERIFY_SOCKET: DurableObjectNamespace;
  VERIFY_WORKFLOW: Workflow;
  /** Pinned starter model under test; the driver writes it into the generated config at deploy. */
  VERIFY_T7_MODEL: string;
  /** Campaign cap on executed /t7/turn calls; the driver bakes in turns + headroom at deploy. */
  VERIFY_T7_BUDGET?: string;
  /** Per-campaign bearer the driver pushes with `wrangler secret put` right after deploy. */
  CF_VERIFY_BEARER?: string;
}

const LEDGER_DDL =
  "CREATE TABLE IF NOT EXISTS ledger (instance_id TEXT, step TEXT, effect TEXT, " +
  "PRIMARY KEY (instance_id, step))";

/** One committed effect per (instance, step): the duplicate-ID error is part of T3 evidence. */
async function commit(db: D1Database, instance: string, step: string, effect: string) {
  await db.exec(LEDGER_DDL);
  await db
    .prepare("INSERT INTO ledger (instance_id, step, effect) VALUES (?, ?, ?)")
    .bind(instance, step, effect)
    .run();
}

export type WorkflowCase = "briefing" | "wait" | "cancel";

export class VerifyWorkflow extends WorkflowEntrypoint<
  FixtureEnv,
  { id: string; kind: WorkflowCase }
> {
  override async run(event: { payload: { id: string; kind: WorkflowCase } }, step: WorkflowStep) {
    const { id, kind } = event.payload;
    if (kind === "briefing") {
      const rows = await step.do("read-fixtures", async () => ["a", "b", "c"]);
      const summary = await step.do("summarize", async () => `stub:${rows.join("+")}`);
      await step.do("write-output", async () => {
        await commit(this.env.DB, id, "briefing", summary);
        await this.env.FILES.put(`${id}/briefing.json`, JSON.stringify({ summary }));
      });
      // Synthetic >1 MiB output must live in R2, with only a reference in step results.
      return await step.do("offload-large-output", async () => {
        const key = `${id}/large.bin`;
        await this.env.FILES.put(key, new Uint8Array(1_100_000).fill(7));
        return { ref: key };
      });
    }
    if (kind === "wait") {
      // A real platform wait: comfortably above 25 h, inside the 48 h campaign.
      const approval = await step.waitForEvent<string>("approval", {
        type: "approval",
        timeout: "40 hours",
      });
      return await step.do("complete-after-approval", async () => {
        await commit(this.env.DB, id, "wait", approval.payload);
        return { approved: true };
      });
    }
    // kind === "cancel": a bounded first step, then a wait the driver terminates.
    await step.do("bounded-first-step", async () => {
      await commit(this.env.DB, id, "cancel-step-1", "done");
    });
    const late = await step.waitForEvent<string>("late-event", {
      type: "late-event",
      timeout: "40 hours",
    });
    return await step.do("must-never-run-after-cancel", async () => {
      await commit(this.env.DB, id, "cancel-step-2", late.payload);
    });
  }
}

/** Constant-time bearer comparison: lengths and every byte both feed the verdict. */
function timingSafeEqual(candidate: string, bearer: string): boolean {
  if (candidate.length !== bearer.length) return false;
  let diff = 0;
  for (let i = 0; i < bearer.length; i++) diff |= bearer.charCodeAt(i) ^ candidate.charCodeAt(i);
  return diff === 0;
}

/** Single-use WebSocket tickets, minted over authenticated POST and consumed on upgrade. */
const TICKET_TTL_MS = 60_000;

async function mintTicket(
  storage: DurableObjectStorage,
): Promise<{ ticket: string; expiresAt: number }> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ticket = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const tickets = ((await storage.get<Record<string, number>>("tickets")) ?? {}) as Record<
    string,
    number
  >;
  for (const [t, exp] of Object.entries(tickets)) if (exp <= now) delete tickets[t];
  tickets[ticket] = now + TICKET_TTL_MS;
  await storage.put("tickets", tickets);
  return { ticket, expiresAt: tickets[ticket] };
}

async function consumeTicket(
  storage: DurableObjectStorage,
  ticket: string | null,
): Promise<boolean> {
  if (!ticket) return false;
  const tickets = ((await storage.get<Record<string, number>>("tickets")) ?? {}) as Record<
    string,
    number
  >;
  // Object.hasOwn, not `in`: an inherited name such as "constructor" must never consult
  // the prototype — only a minted own ticket authenticates.
  if (!Object.hasOwn(tickets, ticket)) return false;
  const exp = tickets[ticket];
  if (typeof exp !== "number" || exp <= Date.now()) return false;
  delete tickets[ticket];
  await storage.put("tickets", tickets);
  return true;
}

const T7_USAGE_DDL =
  "CREATE TABLE IF NOT EXISTS t7_turns (id INTEGER PRIMARY KEY CHECK (id = 1), used INTEGER NOT NULL DEFAULT 0)";

/**
 * Atomic campaign reservation for /t7/turn (TWO-687 finding 2, PR #103 review): the
 * conditional write admits a turn only while `used < budget`, so overlapping requests
 * cannot both spend the last turn. `changes === 0` means the budget is exhausted.
 */
const T7_RESERVE_SQL =
  "INSERT INTO t7_turns (id, used) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET used = used + 1 WHERE used < ?";

async function reserveT7Turn(
  db: D1Database,
  budget: number,
): Promise<{ admitted: boolean; used: number }> {
  await db.exec(T7_USAGE_DDL);
  const outcome = await db.prepare(T7_RESERVE_SQL).bind(budget).run();
  const row = await db.prepare("SELECT used FROM t7_turns WHERE id = 1").first<{ used: number }>();
  const used = typeof row?.used === "number" ? row.used : 0;
  return { admitted: outcome.meta.changes > 0, used };
}

/** Hibernating socket for T4: numbered broadcast log with replay from a sequence number. */
export class VerifySocket extends DurableObject<FixtureEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ticket" && request.method === "POST") {
      return Response.json(await mintTicket(this.ctx.storage));
    }
    if (request.headers.get("Upgrade") === "websocket") {
      // Node's WebSocket client cannot set headers, so upgrades authenticate with a
      // single-use ticket minted by POST /t4/ticket — never the bearer in the URL.
      // Header bearers still work for clients that can set them.
      const header = request.headers.get("authorization");
      const bearer = this.env.CF_VERIFY_BEARER;
      const byHeader =
        !!bearer &&
        !!header?.startsWith("Bearer ") &&
        timingSafeEqual(header.slice("Bearer ".length), bearer);
      if (!byHeader && !(await consumeTicket(this.ctx.storage, url.searchParams.get("ticket")))) {
        return new Response("unauthorized", { status: 401 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      const since = Number(url.searchParams.get("since") ?? -1);
      const events = (await this.ctx.storage.get<string[]>("events")) ?? [];
      for (const [i, e] of events.entries()) if (i > since) server.send(e);
      server.send(JSON.stringify({ hello: true, lastSeq: events.length - 1 }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/log") {
      const events = (await this.ctx.storage.get<string[]>("events")) ?? [];
      return Response.json({ events });
    }
    return new Response("expected websocket", { status: 426 });
  }

  override async webSocketMessage(ws: WebSocket, message: string) {
    let data: { chat?: string };
    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ error: "not-json" }));
      return;
    }
    if (typeof data.chat !== "string") {
      ws.send(JSON.stringify({ error: "expected-chat" }));
      return;
    }
    const events = ((await this.ctx.storage.get<string[]>("events")) ?? []).slice(-511);
    const out = JSON.stringify({ seq: events.length, chat: data.chat });
    events.push(out);
    await this.ctx.storage.put("events", events);
    for (const socket of this.ctx.getWebSockets()) socket.send(out);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _clean: boolean) {
    ws.close(code, reason);
  }
}

// T7 stub registry: the only tools a model may request. Anything else is rejected and scored.
const STUBS = {
  lookupRecord: (args: { id: string }) => ({ id: args.id, value: 41 }),
  add: (args: { a: number; b: number }) => ({ sum: args.a + args.b }),
  artifactRef: (args: { tag: string }) => ({ ref: `synthetic:${args.tag}` }),
};

/** Fail closed: without the bearer every route but /health is 401, even before `secret put`. */
function authorized(request: Request, env: FixtureEnv): boolean {
  const url = new URL(request.url);
  if (url.pathname === "/health") return true;
  const bearer = env.CF_VERIFY_BEARER;
  if (!bearer) return false;
  // The bearer never travels in a URL: every route requires the Authorization header, except
  // /t4/socket upgrades, which Node's WebSocket client cannot send headers on. Those carry
  // a single-use ticket minted by POST /t4/ticket instead; the ticket is opaque here and
  // the DO consumes it, so any value passes this gate and invalid ones still 401 below.
  if (url.pathname === "/t4/socket" && request.headers.get("Upgrade") === "websocket") {
    const header = request.headers.get("authorization");
    if (header?.startsWith("Bearer ") && timingSafeEqual(header.slice("Bearer ".length), bearer))
      return true;
    return url.searchParams.has("ticket");
  }
  const header = request.headers.get("authorization");
  const candidate = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (candidate === null) return false;
  return timingSafeEqual(candidate, bearer);
}

type StubArgs = Record<string, unknown>;

/** One model-requested tool call in driver-facing shape. */
export interface NormalizedCall {
  name: string;
  arguments: unknown;
}

/**
 * Both tool-call response shapes Workers AI models return, in one place. Most models answer
 * `{ tool_calls: [{ name, arguments }] }`; OpenAI-format models (Cloudflare's own
 * function-calling example sends `type: "function"`) answer
 * `{ choices: [{ message: { tool_calls: [{ function: { name, arguments } }] } }] }`.
 * Mirror: normalizeToolCalls in scripts/cf-verify-t3t4t7.mjs.
 */
export function normalizeToolCalls(raw: {
  tool_calls?: {
    name?: string;
    arguments?: unknown;
    function?: { name?: string; arguments?: unknown };
  }[];
  choices?: {
    message?: {
      tool_calls?: {
        name?: string;
        arguments?: unknown;
        function?: { name?: string; arguments?: unknown };
      }[];
    };
  }[];
}): NormalizedCall[] {
  const nested = raw?.choices?.[0]?.message?.tool_calls;
  const list = Array.isArray(nested) && nested.length ? nested : (raw?.tool_calls ?? []);
  return list.map((c) => {
    const fn = c?.function ?? c;
    return { name: fn?.name ?? "", arguments: fn?.arguments };
  });
}

/** Workers AI cap/limit failures (daily neuron limit, 429, capacity): the window stops, not fails. */
export function isAiCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|capacity|quota|neuron|daily.?limit/i.test(message);
}

/** Validate one model's tool arguments against the stub's schema and run it. */
function runStub(name: string, args: unknown): unknown {
  const a = (typeof args === "string" ? JSON.parse(args) : args) as StubArgs;
  if (name === "lookupRecord") {
    if (typeof a?.id !== "string") throw new Error("lookupRecord needs a string id");
    return STUBS.lookupRecord({ id: a.id });
  }
  if (name === "add") {
    if (typeof a?.a !== "number" || typeof a?.b !== "number")
      throw new Error("add needs numeric a and b");
    return STUBS.add({ a: a.a, b: a.b });
  }
  if (name === "artifactRef") {
    if (typeof a?.tag !== "string") throw new Error("artifactRef needs a string tag");
    return STUBS.artifactRef({ tag: a.tag });
  }
  throw new Error(`not-a-stub: ${name}`);
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok", fixture: "t3t4t7" });
    if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/t3/instance" && request.method === "POST") {
      const { id, kind } = (await request.json()) as { id: string; kind: WorkflowCase };
      const instance = await env.VERIFY_WORKFLOW.create({ id, params: { id, kind } });
      return Response.json({ id: instance.id });
    }
    if (url.pathname === "/t3/status" && request.method === "GET") {
      const handle = await env.VERIFY_WORKFLOW.get(url.searchParams.get("id") ?? "");
      return Response.json(await handle.status());
    }
    if (url.pathname === "/t3/ledger" && request.method === "GET") {
      const instance = url.searchParams.get("instance") ?? "";
      await env.DB.exec(LEDGER_DDL);
      const rows = await env.DB.prepare("SELECT step, effect FROM ledger WHERE instance_id = ?")
        .bind(instance)
        .all();
      return Response.json({ instance, effects: rows.results });
    }
    if (url.pathname === "/t3/event" && request.method === "POST") {
      const { id, name, payload } = (await request.json()) as {
        id: string;
        name: string;
        payload: string;
      };
      // sendEvent/terminate live on the instance handle, and the event's routing key is `type`.
      const handle = await env.VERIFY_WORKFLOW.get(id);
      await handle.sendEvent({ type: name, payload });
      return Response.json({ sent: true });
    }
    if (url.pathname === "/t3/terminate" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      const handle = await env.VERIFY_WORKFLOW.get(id);
      await handle.terminate();
      return Response.json({ terminated: true });
    }
    if (url.pathname === "/t4/ticket" && request.method === "POST") {
      const stream = url.searchParams.get("stream") ?? "default";
      const stub = env.VERIFY_SOCKET.get(env.VERIFY_SOCKET.idFromName(stream));
      return stub.fetch(new Request("https://socket/ticket", { method: "POST" }));
    }
    if (url.pathname === "/t4/socket") {
      const stream = url.searchParams.get("stream") ?? "default";
      const since = url.searchParams.get("since") ?? "-1";
      const ticket = url.searchParams.get("ticket") ?? "";
      const stub = env.VERIFY_SOCKET.get(env.VERIFY_SOCKET.idFromName(stream));
      const inner = `https://socket/socket?since=${encodeURIComponent(since)}&ticket=${encodeURIComponent(ticket)}`;
      return stub.fetch(new Request(inner, request));
    }
    if (url.pathname === "/t4/log" && request.method === "GET") {
      const stream = url.searchParams.get("stream") ?? "default";
      return env.VERIFY_SOCKET.get(env.VERIFY_SOCKET.idFromName(stream)).fetch(
        "https://socket/log",
      );
    }
    if (url.pathname === "/t7/turn" && request.method === "POST") {
      const { model, messages, tools } = (await request.json()) as {
        model: string;
        messages: unknown[];
        tools?: { function: { name: string } }[];
      };
      // Only the pinned starter model may run, so a stray or curious caller cannot spend the
      // owner's allowance on another model. The driver bakes the pin into the generated config.
      if (model !== env.VERIFY_T7_MODEL) {
        return Response.json({ error: "model-not-allowed" }, { status: 400 });
      }
      // 2,048 input tokens ≈ 8k characters; the 16k-byte cap leaves headroom without letting a
      // caller stuff the context. Output is clamped server-side: max_tokens is never trusted
      // from the client.
      if (JSON.stringify(messages ?? []).length > 16_384) {
        return Response.json({ error: "messages-too-large" }, { status: 400 });
      }
      // Boundary: the fixture never offers a non-stub tool to the model. Anything outside the
      // registry is rejected here and scored as a model failure driver-side, never executed.
      // Object.hasOwn, not `in`: `"constructor" in STUBS` is true.
      const outside = (tools ?? []).filter((t) => !Object.hasOwn(STUBS, t?.function?.name));
      if (outside.length) {
        return Response.json({ rejected: outside.map((t) => t?.function?.name) }, { status: 400 });
      }
      // Server-side campaign cap (TWO-687 finding 2): the driver bounds its own turns, but
      // the fixture itself refuses past the budget so a stray or curious caller cannot spend
      // the owner's allowance. Past budget reads exactly like an AI cap: the driver stops
      // inconclusive on `ai-capacity`, never failed. Attempts (not 400s) burn budget, and
      // the reservation is one conditional write so overlapping requests cannot overspend.
      const parsed = Number.parseInt(env.VERIFY_T7_BUDGET ?? "", 10);
      const budget = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1050;
      const reservation = await reserveT7Turn(env.DB, budget);
      if (!reservation.admitted) {
        return Response.json({ error: "ai-capacity" }, { status: 429 });
      }
      const started = Date.now();
      let raw: Parameters<typeof normalizeToolCalls>[0];
      try {
        raw = (await env.AI.run(
          model as never,
          {
            messages,
            tools,
            max_tokens: 512,
          } as never,
        )) as Parameters<typeof normalizeToolCalls>[0];
      } catch (error) {
        // A cap or limit error is a stop-inconclusive signal for the driver, never a 500.
        if (isAiCapacityError(error))
          return Response.json({ error: "ai-capacity" }, { status: 429 });
        return Response.json({ error: "ai-error" }, { status: 500 });
      }
      // Execute each requested stub with the model's own arguments and return the results, so
      // the driver scores the final result — not just the name — without another model round.
      // `calls` is the normalized list the driver scores; `raw` stays for evidence.
      const calls = normalizeToolCalls(raw ?? {});
      const executions = calls.map((c) => {
        if (!Object.hasOwn(STUBS, c.name)) return { name: c.name, error: "not-a-stub" };
        try {
          return { name: c.name, result: runStub(c.name, c.arguments) };
        } catch (error) {
          return { name: c.name, error: error instanceof Error ? error.message : String(error) };
        }
      });
      return Response.json({
        model,
        raw,
        calls,
        executions,
        latencyMs: Date.now() - started,
        quota: { used: reservation.used, budget },
      });
    }
    return new Response("not found", { status: 404 });
  },
};
