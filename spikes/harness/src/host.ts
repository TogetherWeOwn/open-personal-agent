// SPDX-License-Identifier: Apache-2.0
// Shared Durable Object host so both variants run in the same place the product loop will.
import { DurableObject } from "cloudflare:workers";
import { deleted, type HarnessEvent, type SpikeHarness } from "./shared";

export abstract class SessionBase extends DurableObject {
  protected abstract readonly harness: SpikeHarness;
  private controller: AbortController | undefined;

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const body = (await request.json()) as {
      text?: string;
      approvalId?: string;
      approved?: boolean;
    };
    if (pathname === "/cancel") {
      this.controller?.abort(new DOMException("cancelled by user", "AbortError"));
      return Response.json({ ok: true });
    }
    if (pathname === "/deleted") return Response.json(deleted);
    const controller = new AbortController();
    this.controller = controller;
    const events =
      pathname === "/approve"
        ? this.harness.approve(body.approvalId ?? "", body.approved === true, controller.signal)
        : this.harness.turn(body.text ?? "", controller.signal);
    return ndjson(events);
  }
}

function ndjson(events: AsyncIterable<HarnessEvent>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        for await (const e of events) c.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      } catch (err) {
        const end: HarnessEvent = { type: "turn.end", reason: "error", message: String(err) };
        c.enqueue(encoder.encode(`${JSON.stringify(end)}\n`));
      }
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

/** `/<builtin|aisdk>/<session>/<turn|approve|cancel|deleted>` goes to that session's object. */
export const worker = {
  fetch(request: Request, env: Record<string, DurableObjectNamespace | undefined>) {
    const [, variant = "", session, action] = new URL(request.url).pathname.split("/");
    const ns = env[variant.toUpperCase()];
    if (!ns || !session || !action) return new Response("not found", { status: 404 });
    return ns.get(ns.idFromName(session)).fetch(`https://do/${action}`, request);
  },
};
