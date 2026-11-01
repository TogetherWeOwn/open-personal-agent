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

/** Hibernating socket for T4: numbered broadcast log with replay from a sequence number. */
export class VerifySocket extends DurableObject<FixtureEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
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
  // Node's WebSocket client cannot set headers, so /t4/socket also accepts the bearer as a
  // query param. Every other route requires the Authorization header. Either way the value
  // never lands in logs or artifacts: the driver redacts it from everything it records.
  const header = request.headers.get("authorization");
  const candidate =
    header?.startsWith("Bearer ") && url.pathname !== "/t4/socket"
      ? header.slice("Bearer ".length)
      : url.pathname === "/t4/socket"
        ? header?.startsWith("Bearer ")
          ? header.slice("Bearer ".length)
          : url.searchParams.get("bearer")
        : null;
  if (candidate === null || candidate.length !== bearer.length) return false;
  let diff = 0;
  for (let i = 0; i < bearer.length; i++) diff |= bearer.charCodeAt(i) ^ candidate.charCodeAt(i);
  return diff === 0;
}

type StubArgs = Record<string, unknown>;

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
      return Response.json(await env.VERIFY_WORKFLOW.get(url.searchParams.get("id") ?? ""));
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
    if (url.pathname === "/t4/socket") {
      const stream = url.searchParams.get("stream") ?? "default";
      const since = url.searchParams.get("since") ?? "-1";
      const stub = env.VERIFY_SOCKET.get(env.VERIFY_SOCKET.idFromName(stream));
      const inner = `https://socket/socket?since=${encodeURIComponent(since)}`;
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
      const outside = (tools ?? []).filter((t) => !Object.hasOwn(STUBS, t.function.name));
      if (outside.length) {
        return Response.json({ rejected: outside.map((t) => t.function.name) }, { status: 400 });
      }
      const started = Date.now();
      const raw = (await env.AI.run(
        model as never,
        {
          messages,
          tools,
          max_tokens: 512,
        } as never,
      )) as { tool_calls?: { name: string; arguments?: unknown }[] };
      // Execute each requested stub with the model's own arguments and return the results, so
      // the driver scores the final result — not just the name — without another model round.
      const calls = raw?.tool_calls ?? [];
      const executions = calls.map((c) => {
        if (!Object.hasOwn(STUBS, c.name)) return { name: c.name, error: "not-a-stub" };
        try {
          return { name: c.name, result: runStub(c.name, c.arguments) };
        } catch (error) {
          return { name: c.name, error: error instanceof Error ? error.message : String(error) };
        }
      });
      return Response.json({ model, raw, executions, latencyMs: Date.now() - started });
    }
    return new Response("not found", { status: 404 });
  },
};
