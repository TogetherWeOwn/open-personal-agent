// SPDX-License-Identifier: Apache-2.0
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "../src/shared";

async function* lines(res: Response): AsyncGenerator<HarnessEvent> {
  const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
    if (done) break;
    buf += value;
    let i = buf.indexOf("\n");
    while (i >= 0) {
      yield JSON.parse(buf.slice(0, i)) as HarnessEvent;
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
    }
  }
}

const post = (path: string, body: unknown) =>
  exports.default.fetch(`https://spike.test${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

async function collect(res: Response): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of lines(res)) out.push(e);
  return out;
}

const text = (events: HarnessEvent[]) =>
  events.map((e) => (e.type === "text.delta" ? e.text : "")).join("");

describe.each(["builtin", "aisdk"])("%s", (variant) => {
  it("gates the tool until approved, then finishes the turn", async () => {
    const s = `/${variant}/approve`;
    const first = await collect(await post(`${s}/turn`, { text: `delete /${variant}/a` }));
    const ask = first.find((e) => e.type === "approval.requested");
    expect(ask).toMatchObject({ call: { name: "delete_file", input: { path: `/${variant}/a` } } });
    expect(first.at(-1)).toMatchObject({ type: "turn.end", reason: "awaiting_approval" });
    const before = await (await post(`${s}/deleted`, {})).json();
    expect(before).not.toContain(`/${variant}/a`);

    const approvalId = ask?.type === "approval.requested" ? ask.approvalId : "";
    const second = await collect(await post(`${s}/approve`, { approvalId, approved: true }));
    expect(second).toContainEqual(expect.objectContaining({ type: "tool.result" }));
    expect(text(second)).toBe(`Tool said: deleted /${variant}/a`);
    expect(second.at(-1)).toMatchObject({ type: "turn.end", reason: "stop" });
    expect(await (await post(`${s}/deleted`, {})).json()).toContain(`/${variant}/a`);
  });

  it("does not run a denied tool and lets the model answer", async () => {
    const s = `/${variant}/deny`;
    const first = await collect(await post(`${s}/turn`, { text: `delete /${variant}/b` }));
    const ask = first.find((e) => e.type === "approval.requested");
    const approvalId = ask?.type === "approval.requested" ? ask.approvalId : "";
    const second = await collect(await post(`${s}/approve`, { approvalId, approved: false }));
    expect(text(second)).toMatch(/^Tool said: .*denied/i);
    expect(await (await post(`${s}/deleted`, {})).json()).not.toContain(`/${variant}/b`);
  });

  it("cancels mid-stream and keeps the session usable", async () => {
    const s = `/${variant}/cancel`;
    const events: HarnessEvent[] = [];
    let deltas = 0;
    for await (const e of lines(await post(`${s}/turn`, { text: "hello" }))) {
      events.push(e);
      if (e.type === "text.delta" && ++deltas === 3) await post(`${s}/cancel`, {});
    }
    expect(events.at(-1)).toMatchObject({ type: "turn.end", reason: "cancelled" });
    expect(deltas).toBeLessThan(10);

    const next = await collect(await post(`${s}/turn`, { text: `delete /${variant}/c` }));
    expect(next.at(-1)).toMatchObject({ type: "turn.end", reason: "awaiting_approval" });
  });
});
