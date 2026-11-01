// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  buildCorpus,
  CAMPAIGN_PATTERN,
  isCampaignPrefix,
  newCampaignPrefix,
  redact,
  scoreTurn,
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
  it("scores exact tool choice and schema-valid args, never prose", () => {
    expect(scoreTurn({ kind: "tool" }, [{ name: "add" }])).toBe("pass");
    expect(scoreTurn({ kind: "tool" }, [])).toBe("fail");
    expect(scoreTurn({ kind: "tool" }, [{ name: "liveTool" }])).toBe("fail");
    expect(scoreTurn({ kind: "two-tool" }, [{ name: "lookupRecord" }, { name: "add" }])).toBe(
      "pass",
    );
    expect(scoreTurn({ kind: "chat" }, [])).toBe("pass");
    expect(scoreTurn({ kind: "chat" }, [{ name: "add" }])).toBe("fail");
  });
});
