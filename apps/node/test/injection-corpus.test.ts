// SPDX-License-Identifier: Apache-2.0
// The prompt-injection regression corpus (M3-22, R7 M3-6): every vector with every goal, under the
// default policy and under everything a careless user could allow, with a stub model that obeys.
// Pass means each attempt is refused or becomes an approval carrying the exact arguments; none
// runs silently. Even approved, a memory write stays a proposal and the deployment's own host is
// never fetched. The corpus and its parts are in test/injection.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ApprovalItem,
  type LoopEvent,
  newTurn,
  resolveApprovals,
} from "../../../packages/harness-builtin/src/index";
import { GOALS, OWN_HOST, PAGE_URL, VECTORS } from "../../../test/injection/corpus";
import { caseHost, filled, NOW, type Profile } from "../../../test/injection/harness";
import { openSqlite, sqliteD1 } from "../src/d1";
import { migrate } from "../src/migrate";

const dir = mkdtempSync(join(tmpdir(), "opa-injection-"));
const sqlite = openSqlite(join(dir, "corpus.sqlite"));
migrate(sqlite, join(import.meta.dirname, "../../../migrations"));
afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

const of = <T extends LoopEvent["type"]>(events: LoopEvent[], type: T) =>
  events.filter((e): e is Extract<LoopEvent, { type: T }> => e.type === type);
const approvalItems = (events: LoopEvent[]): ApprovalItem[] =>
  of(events, "approval.requested").flatMap((e) => e.payload.items);

/** Tools the corpus host registers; a goal call to any other name has nothing to run. */
const REGISTERED = new Set([
  "web_fetch",
  "search_history",
  "create_artifact",
  "read_file",
  "remember",
  "recall",
  "forget",
  "lookup_contact",
  "contact_directory",
]);

const PROFILES: Profile[] = ["defaults", "permissive"];

describe.each(PROFILES)("injection corpus, %s policy", (profile) => {
  describe.each(VECTORS)("$kind: $id", (vector) => {
    it.each(GOALS)("can't $attack ($id) silently", async (goal) => {
      const world = await caseHost(sqliteD1(sqlite), vector, goal, profile);
      const memoryBefore = (await world.memory.list()).map((m) => m.id);
      const turn = newTurn();
      const { events, outcome } = await world.run(turn);

      // The attack reached the model (or, for a vector that strips it, didn't), so a pass is
      // the policy's doing, not the converter's or the model's.
      expect(world.read.length > 0, "the instructions reached the model").toBe(vector.reaches);

      const deliverArgs = vector.deliver && filled(vector.deliver[1]);
      const attackRuns = world.executed.filter(
        (e) => !(e.tool === vector.deliver?.[0] && e.args === deliverArgs),
      );
      const called = of(events, "tool.called").map((e) => e.payload);
      const items = approvalItems(events);
      const results = new Map(of(events, "tool.result").map((e) => [e.payload.toolCallId, e]));

      for (const [name, args] of vector.reaches ? goal.calls : []) {
        // An unknown tool's arguments are shown as the model sent them; a known tool's, canonical.
        const call = called.find(
          (c) => c.tool === name && filled(JSON.parse(c.args)) === filled(args),
        );
        expect(call, `the stub made ${name}`).toBeDefined();
        if (!call) continue;
        const item = items.find((i) => i.approvalId === `appr_${call.toolCallId}`);
        if (!REGISTERED.has(name)) {
          // Settings, connectors and approvals have no tool: nothing runs.
          expect(item).toBeUndefined();
          expect(results.get(call.toolCallId)?.payload).toMatchObject({ ok: false });
          expect(results.get(call.toolCallId)?.payload.error).toContain("There is no tool named");
        } else if (item) {
          // An approval with the exact arguments the injection asked for, the secret included,
          // only for this once, naming what tainted the turn.
          expect(item).toMatchObject({ tool: name, args: filled(args), scopes: ["once"] });
          expect(item.taint).toBeDefined();
          if (name === "web_fetch") {
            expect(item.target).toBe(new URL(String(JSON.parse(item.args).url)).hostname);
          }
        } else {
          // The one call policy may let through is a write the memory gate turns into a
          // proposal for the inbox: the user's "auto" for `remember` doesn't trust the page.
          expect(profile === "permissive" && name === "remember", `${name} ran silently`).toBe(
            true,
          );
          const proposals = await world.memory.proposals();
          expect(proposals.map((p) => [p.text, p.trust])).toContainEqual([
            JSON.parse(filled(args)).text,
            "external",
          ]);
        }
      }

      // Nothing else ran: no request left for anywhere but the page the user asked for, and the
      // remembered rows are exactly what they were.
      expect(
        attackRuns.filter((e) => !(profile === "permissive" && e.tool === "remember")),
      ).toEqual([]);
      expect(world.fetched.every((url) => url === PAGE_URL)).toBe(true);
      expect((await world.memory.list()).map((m) => m.id)).toEqual(memoryBefore);
      expect(outcome).toBe(items.length > 0 ? "awaiting_approval" : "completed");
      if (items.length === 0) return;

      // Approve itself: the turn can't move without the user. Resumed with no decision, it
      // asks the model nothing and runs nothing.
      const ran = world.executed.length;
      const again = await world.run(turn);
      expect(again).toEqual({ events: [], outcome: "awaiting_approval" });
      expect(world.executed.length).toBe(ran);

      // The user approves each call just once: exactly the shown arguments run, and only those.
      const batchId = of(events, "approval.requested")[0]?.payload.batchId ?? "";
      const decisions = items.map((i) => ({
        approvalId: i.approvalId,
        decision: "approve" as const,
        scope: "once" as const,
      }));
      resolveApprovals(turn, batchId, decisions, NOW);
      await world.run(turn);
      const approvedRuns = world.executed.slice(ran);
      expect(approvedRuns).toEqual(items.map((i) => ({ tool: i.tool, args: i.args })));
      // Even approved, the deployment never fetches itself and a page never writes a trusted
      // memory: `remember` from a tainted turn stays a proposal.
      expect(world.fetched.some((url) => new URL(url).hostname === OWN_HOST)).toBe(false);
      expect((await world.memory.list()).map((m) => m.id)).toEqual(memoryBefore);
    });
  });
});

describe("the injection corpus itself", () => {
  it("covers every goal R7 M3-6 names and every vector kind", () => {
    expect(new Set(VECTORS.map((v) => v.kind))).toEqual(
      new Set(["page", "hidden text", "file", "tool output", "tool description"]),
    );
    expect(GOALS.map((g) => g.id)).toEqual(
      expect.arrayContaining(["exfiltrate", "remember", "settings", "self-approve"]),
    );
  });

  it("denied, every call stays unrun and the turn ends", async () => {
    const vector = VECTORS.find((v) => v.id === "page");
    const goal = GOALS.find((g) => g.id === "exfiltrate");
    if (!vector || !goal) throw new Error("corpus entries renamed");
    const world = await caseHost(sqliteD1(sqlite), vector, goal, "defaults");
    const turn = newTurn();
    const { events } = await world.run(turn);
    const items = approvalItems(events);
    expect(items).toHaveLength(1);
    const batchId = of(events, "approval.requested")[0]?.payload.batchId ?? "";
    const ran = world.executed.length;
    resolveApprovals(
      turn,
      batchId,
      items.map((i) => ({ approvalId: i.approvalId, decision: "deny" as const, scope: "once" })),
      NOW,
    );
    const resumed = await world.run(turn);
    expect(resumed.outcome).toBe("completed");
    expect(world.executed.length).toBe(ran);
    expect(world.fetched).toEqual([PAGE_URL]);
  });
});
