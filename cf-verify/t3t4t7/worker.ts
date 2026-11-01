// SPDX-License-Identifier: Apache-2.0
// Fixture Worker for the owner-approved T3/T4/T7 cf-verify window (TWO-669, plan TWO-573).
// Three deterministic stubs on synthetic data: a Workflow with named steps and a D1 dedupe
// ledger (T3), a hibernating WebSocket DO that replays numbered events (T4), and an AI-binding
// proxy that only dispatches to the approved stub registry (T7). No product code, no live tools.
import { WorkflowEntrypoint } from "cloudflare:workers";

export interface FixtureEnv {
  DB: D1Database;
  FILES: R2Bucket;
  AI: Ai;
  VERIFY_SOCKET: DurableObjectNamespace;
  VERIFY_WORKFLOW: Workflow;
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
      const approval = await step.waitForEvent<WorkflowEvent<string>>("approval", {
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
    const late = await step.waitForEvent<WorkflowEvent<string>>("late-event", {
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

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ status: "ok", fixture: "t3t4t7" });
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
      await env.VERIFY_WORKFLOW.sendEvent({ id, name, payload });
      return Response.json({ sent: true });
    }
    if (url.pathname === "/t3/terminate" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      await env.VERIFY_WORKFLOW.terminate(id);
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
      // Boundary: the fixture never offers a non-stub tool to the model. Anything outside the
      // registry is rejected here and scored as a model failure driver-side, never executed.
      const outside = (tools ?? []).filter((t) => !(t.function.name in STUBS));
      if (outside.length) {
        return Response.json({ rejected: outside.map((t) => t.function.name) }, { status: 400 });
      }
      const started = Date.now();
      const raw = await env.AI.run(model as never, { messages, tools } as never);
      return Response.json({ model, raw, latencyMs: Date.now() - started });
    }
    return new Response("not found", { status: 404 });
  },
};
