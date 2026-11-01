// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BOUNDS,
  buildCorpus,
  CAMPAIGN_PATTERN,
  checkTabCoverage,
  collect,
  deepEqual,
  isCampaignPrefix,
  isCapacityError,
  newCampaignPrefix,
  normalizeToolCalls,
  openSocket,
  redact,
  renderDeployConfig,
  scoreTurn,
  stubResult,
  teardown,
  waitReady,
} from "../cf-verify-t3t4t7.mjs";
import { teardownCloudflare } from "../teardown-cloudflare.mjs";

const Q4 = "opa-v-q4-20251101-a1b2c3d4";
const LEGACY = "opa-v-20251101-abc123";

describe("campaign prefix", () => {
  it("accepts the q4 form and the legacy M2 form, nothing else", () => {
    expect(isCampaignPrefix(Q4)).toBe(true);
    expect(isCampaignPrefix(LEGACY)).toBe(true);
    for (const bad of [
      "opa",
      "opa-v-1",
      "opa-v-q4-20251101-xyz",
      `${Q4}9`,
      "opa-v-q4-2025110-a1b2c3d4",
    ]) {
      expect(isCampaignPrefix(bad)).toBe(false);
    }
    expect(Q4).toMatch(CAMPAIGN_PATTERN);
    expect(LEGACY).not.toMatch(CAMPAIGN_PATTERN);
  });
  it("mints q4 prefixes with the UTC date and 8 hex", () => {
    const prefix = newCampaignPrefix(
      new Date("2026-11-01T06:33:43Z"),
      () => new Uint8Array([1, 2, 3, 4]),
    );
    expect(prefix).toBe("opa-v-q4-20261101-01020304");
  });
  it("teardown still refuses non-prefixes and accepts the q4 form", async () => {
    const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acc" };
    const fetch = async () => ({ status: 200, ok: true, json: async () => ({ result: [] }) });
    const deps = { env, fetch, stdout: () => {} };
    await expect(teardownCloudflare(["--name", "opa", "--confirm", "opa"], deps)).rejects.toThrow(
      /refusing/,
    );
    await teardownCloudflare(["--name", Q4], deps);
  });
});

describe("redaction", () => {
  it("scrubs tokens and the workers.dev subdomain", () => {
    const out = redact("token secret-tok url https://a-b.my-sub.workers.dev/x", ["secret-tok"]);
    expect(out).toBe("token [redacted] url https://a-b.<subdomain>.workers.dev/x");
  });
});

describe("t7 corpus and scoring", () => {
  it("keeps the 1,000-turn target: 500 tool, 300 two-tool, 200 chat", () => {
    const corpus = buildCorpus();
    expect(corpus).toHaveLength(BOUNDS.t7.turns);
    expect(corpus.filter((t) => t.kind === "tool")).toHaveLength(500);
    expect(corpus.filter((t) => t.kind === "two-tool")).toHaveLength(300);
    expect(corpus.filter((t) => t.kind === "chat")).toHaveLength(200);
  });
  it("carries an expected tool sequence and args every tool turn can actually run", () => {
    for (const t of buildCorpus()) {
      if (t.kind === "chat") {
        expect(t.expect).toEqual([]);
        continue;
      }
      expect(t.expect.length).toBeGreaterThan(0);
      for (const e of t.expect) expect(() => stubResult(e.name, e.args)).not.toThrow();
    }
  });
  it("passes exact name, args and stub result; fails wrong tool, wrong args, wrong result", () => {
    const turn = { kind: "tool", expect: [{ name: "add", args: { a: 1, b: 2 } }] };
    const good = [{ name: "add", arguments: { a: 1, b: 2 } }];
    const exec = [{ name: "add", result: { sum: 3 } }];
    expect(scoreTurn(turn, good, exec)).toBe("pass");
    // Serialised arguments (some models serialise) with reordered keys still pass.
    expect(scoreTurn(turn, [{ name: "add", arguments: '{"b":2,"a":1}' }], exec)).toBe("pass");
    // A model that always calls add fails a lookupRecord turn.
    const lookup = { kind: "tool", expect: [{ name: "lookupRecord", args: { id: "rec-3" } }] };
    expect(
      scoreTurn(
        lookup,
        [{ name: "add", arguments: { a: 1, b: 2 } }],
        [{ name: "add", result: { sum: 3 } }],
      ),
    ).toBe("fail");
    // Right name, wrong args.
    expect(
      scoreTurn(
        turn,
        [{ name: "add", arguments: { a: 1, b: 3 } }],
        [{ name: "add", result: { sum: 4 } }],
      ),
    ).toBe("fail");
    // Right call, wrong stub result.
    expect(scoreTurn(turn, good, [{ name: "add", result: { sum: 99 } }])).toBe("fail");
    // Errored executions and missing executions fail too.
    expect(scoreTurn(turn, good, [{ name: "add", error: "add needs numeric a and b" }])).toBe(
      "fail",
    );
    expect(scoreTurn(turn, good, [])).toBe("fail");
    // Chat passes only with no calls.
    expect(scoreTurn({ kind: "chat", expect: [] }, [])).toBe("pass");
    expect(scoreTurn({ kind: "chat", expect: [] }, good)).toBe("fail");
  });
  it("scores two-tool turns in order", () => {
    const turn = {
      kind: "two-tool",
      expect: [
        { name: "lookupRecord", args: { id: "rec-1" } },
        { name: "add", args: { a: 1, b: 2 } },
      ],
    };
    const emitted = [
      { name: "lookupRecord", arguments: { id: "rec-1" } },
      { name: "add", arguments: { a: 1, b: 2 } },
    ];
    const exec = [
      { name: "lookupRecord", result: { id: "rec-1", value: 41 } },
      { name: "add", result: { sum: 3 } },
    ];
    expect(scoreTurn(turn, emitted, exec)).toBe("pass");
    expect(scoreTurn(turn, [...emitted].reverse(), [...exec].reverse())).toBe("fail");
  });
  it("rejects prototype names: constructor is not a stub", () => {
    expect(() => stubResult("constructor", {})).toThrow(/not-a-stub/);
    const turn = { kind: "tool", expect: [{ name: "add", args: { a: 1, b: 2 } }] };
    expect(scoreTurn(turn, [{ name: "constructor", arguments: {} }], [])).toBe("fail");
  });
  it("compares args structurally, not by key order", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("t4 coverage", () => {
  it("flags missed and duplicated seqs, not just missed", () => {
    expect(checkTabCoverage(3, [0, 1, 2])).toEqual({ missing: [], duplicated: [] });
    expect(checkTabCoverage(3, [0, 0, 2])).toEqual({ missing: [1], duplicated: [0] });
    expect(checkTabCoverage(2, [])).toEqual({ missing: [0, 1], duplicated: [] });
  });
});

describe("t7 tool-call shapes", () => {
  it("normalizes the flat and the OpenAI-nested response shapes", () => {
    expect(
      normalizeToolCalls({ tool_calls: [{ name: "add", arguments: { a: 1, b: 2 } }] }),
    ).toEqual([{ name: "add", arguments: { a: 1, b: 2 } }]);
    expect(
      normalizeToolCalls({
        choices: [
          { message: { tool_calls: [{ function: { name: "add", arguments: '{"a":1,"b":2}' } }] } },
        ],
      }),
    ).toEqual([{ name: "add", arguments: '{"a":1,"b":2}' }]);
    // A nested list wins when present; anything else falls back to the flat list.
    expect(
      normalizeToolCalls({
        tool_calls: [{ name: "add", arguments: { a: 1, b: 2 } }],
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: "lookupRecord", arguments: { id: "rec-1" } } }],
            },
          },
        ],
      }),
    ).toEqual([{ name: "lookupRecord", arguments: { id: "rec-1" } }]);
    expect(normalizeToolCalls({})).toEqual([]);
  });
  it("maps cap and limit errors to inconclusive, nothing else", () => {
    const http429 = new Error("POST https://x: HTTP 429");
    http429.status = 429;
    expect(isCapacityError(http429)).toBe(true);
    const capBody = new Error("POST https://x: HTTP 500");
    capBody.status = 500;
    capBody.body = { error: "ai-capacity" };
    expect(isCapacityError(capBody)).toBe(true);
    // A campaign prefix containing 429 in the fixture URL must not match: the message
    // is never scored, only status and body.
    const prefix429 = new Error(
      "GET https://opa-v-q4-20261101-a1b24294-t3t4t7.<subdomain>.workers.dev/t4/log: HTTP 500",
    );
    prefix429.status = 500;
    expect(isCapacityError(prefix429)).toBe(false);
    expect(isCapacityError(new Error("daily neuron limit reached"))).toBe(false);
    expect(isCapacityError(new Error("ai-capacity"))).toBe(false);
    expect(isCapacityError(new Error("fixture deploy failed"))).toBe(false);
    expect(isCapacityError(new Error("model-not-allowed"))).toBe(false);
  });
  it("renders a generated config whose main resolves to an existing file", () => {
    const rendered = renderDeployConfig(Q4, "some-model");
    expect(rendered).toContain(Q4);
    const match = rendered.match(/"main":\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(path.isAbsolute(match[1])).toBe(true);
    expect(fs.existsSync(match[1])).toBe(true);
  });
});

describe("t4 reconnect bookkeeping", () => {
  it("keeps the tab array live: replay appends to it and later events land in it", async () => {
    const instances = [];
    class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.handlers = {};
        instances.push(this);
      }
      addEventListener(type, fn) {
        if (!this.handlers[type]) this.handlers[type] = [];
        this.handlers[type].push(fn);
      }
      send() {}
      close() {
        this.closed = true;
      }
      emit(type, event) {
        for (const fn of this.handlers[type] ?? []) fn(event);
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    try {
      // Tab holds seqs 0-8, reconnects with since=8, replays 9-10, then lives on.
      const received = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      const opened = openSocket("https://w.example.workers.dev", "s", 8, "bearer", received);
      const sock = instances.at(-1);
      expect(sock.url).toContain("since=8");
      sock.emit("message", { data: JSON.stringify({ seq: 9, chat: "a" }) });
      sock.emit("message", { data: JSON.stringify({ seq: 10, chat: "b" }) });
      sock.emit("message", { data: JSON.stringify({ hello: true, lastSeq: 10 }) });
      const tab = await opened;
      expect(tab.received).toBe(received);
      // A live event after the reconnect lands in the same array — the stale-copy bug.
      sock.emit("message", { data: JSON.stringify({ seq: 11, chat: "c" }) });
      expect(tab.received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(checkTabCoverage(12, tab.received)).toEqual({ missing: [], duplicated: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("teardown and collect without a bearer", () => {
  const emptyApi = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ success: true, result: [] }),
  });
  it("teardown deletes by prefix with only the account token", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-verify-"));
    vi.stubEnv("RUNNER_TEMP", tmp);
    vi.stubGlobal("fetch", emptyApi);
    try {
      const lines = [];
      const out = await teardown(Q4, {
        env: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acc" },
        stdout: (t) => lines.push(t),
      });
      expect(out).toEqual({ deleted: [] });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("collect writes redacted evidence without a bearer", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-verify-"));
    vi.stubEnv("RUNNER_TEMP", tmp);
    try {
      const dir = await collect(Q4, { env: {}, stdout: () => {} });
      for (const test of ["t3", "t4", "t7"]) {
        const body = fs.readFileSync(path.join(dir, `${test}-evidence.md`), "utf8");
        expect(body).toContain("(no observations: inconclusive)");
      }
      expect(fs.existsSync(path.join(dir, "steps.md"))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("25 h callback gate", () => {
  it("refuses an early callback and accepts one at or after 25 h", () => {
    const start = "2026-11-01T00:00:00.000Z";
    expect(waitReady(start, Date.parse(start) + 25 * 3600_000 - 1)).toBe(false);
    expect(waitReady(start, Date.parse(start) + 25 * 3600_000)).toBe(true);
  });
});
