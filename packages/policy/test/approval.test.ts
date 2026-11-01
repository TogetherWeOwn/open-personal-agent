// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  type ApprovalBindingInput,
  type BatchDecisionItem,
  batchDigest,
  bindApproval,
  CanonicalError,
  fromBase64Url,
  jcs,
  openApproval,
  sha256,
  stepUpChallenge,
  type ToolManifest,
  toBase64Url,
  toolDefinitionHash,
} from "../src";

const manifest: ToolManifest = {
  name: "send_email",
  description: "Sends an email.",
  inputSchema: { type: "object", properties: { to: { type: "string" } } },
  riskClass: "irreversible",
  destinations: [{ id: "email", kind: "third_party", dataEgress: true }],
  scopes: ["email:send"],
};

const base: ApprovalBindingInput = {
  userId: "user-a",
  manifest,
  args: { to: "owner@example.com", body: "hi" },
  target: "example.com",
  context: { kind: "turn", id: "turn-1", conversationId: "conv-1" },
  toolCallId: "call_1",
};

const hashOf = async (input: Partial<ApprovalBindingInput>) =>
  (await bindApproval({ ...base, ...input })).bindingHash;

describe("jcs (RFC 8785)", () => {
  it("matches the RFC's §3.2.3 example", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    );
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    // Read the values back in the text's order: a parsed object would list "1" first.
    const values = [...jcs(input).matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
  });

  it.each([
    [0, "0"],
    [-0, "0"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740991, "9007199254740991"],
    [1e21, "1e+21"],
    [2 ** 53, "9007199254740992"],
    [1e-7, "1e-7"],
    [0.000001, "0.000001"],
    [100, "100"],
  ])("serialises %s as %s (RFC 8785 Appendix B)", (n, text) => {
    expect(jcs(n)).toBe(text);
  });

  it("refuses what it can't represent without changing it (crypto review C3)", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "\uD800",
      { "\uDC00": 1 },
      { a: undefined },
      new Date(0),
      () => 1,
      1n,
    ]) {
      expect(() => jcs(bad), String(bad)).toThrow(CanonicalError);
    }
  });

  it("refuses values nested too deeply or too large", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => jcs(deep)).toThrow(/nested/);
    expect(() => jcs("x".repeat(70_000))).toThrow(/too large/);
  });
});

describe("bindApproval (crypto review C1, C2, C4)", () => {
  it("hashes the same arguments the same, whatever their key order", async () => {
    const a = await hashOf({ args: { to: "x@example.com", body: "hi" } });
    const b = await hashOf({ args: { body: "hi", to: "x@example.com" } });
    expect(a).toBe(b);
  });

  it('treats 100 and 1e2, -0 and 0 as the same number, and 1 and "1" as different', async () => {
    expect(await hashOf({ args: { n: 100 } })).toBe(await hashOf({ args: { n: 1e2 } }));
    expect(await hashOf({ args: { n: -0 } })).toBe(await hashOf({ args: { n: 0 } }));
    expect(await hashOf({ args: { n: 1 } })).not.toBe(await hashOf({ args: { n: "1" } }));
  });

  it("never normalises Unicode: composed and decomposed é bind differently", async () => {
    const composed = await hashOf({ args: { to: "café" } });
    const decomposed = await hashOf({ args: { to: "café" } });
    expect(composed).not.toBe(decomposed);
  });

  it("binds every field: user, tool definition, target, context and the call", async () => {
    const hash = await hashOf({});
    const changed = [
      await hashOf({ userId: "user-b" }),
      await hashOf({ manifest: { ...manifest, description: "Sends an email, changed." } }),
      await hashOf({ target: "example.net" }),
      await hashOf({ target: null }),
      await hashOf({ args: { to: "owner@example.com", body: "hi!" } }),
      // Two identical calls in one turn bind differently (tool_call_id).
      await hashOf({ toolCallId: "call_2" }),
      // The same call in a turn and in a task binds differently (tagged context).
      await hashOf({ context: { kind: "task", id: "turn-1", conversationId: "conv-1" } }),
      await hashOf({ context: { kind: "turn", id: "turn-1", conversationId: "conv-2" } }),
    ];
    for (const other of changed) expect(other).not.toBe(hash);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it("stores the envelope as JCS text that hashes to the binding", async () => {
    const { canonical, bindingHash } = await bindApproval(base);
    expect(jcs(JSON.parse(canonical))).toBe(canonical);
    expect(toBase64Url(await sha256(new TextEncoder().encode(canonical)))).toBe(bindingHash);
    expect(JSON.parse(canonical)).toMatchObject({
      v: 1,
      domain: "opa.approval.v1",
      user_id: "user-a",
      tool: "send_email",
      tool_def_sha256: await toolDefinitionHash(manifest),
      target: "example.com",
      context: { kind: "turn", id: "turn-1", conversation_id: "conv-1" },
      tool_call_id: "call_1",
    });
    expect(fromBase64Url(bindingHash)).toHaveLength(32);
  });

  it("reopens only an envelope that still hashes to its binding", async () => {
    const { canonical, bindingHash } = await bindApproval(base);
    expect(await openApproval(canonical, bindingHash)).toEqual({
      userId: "user-a",
      tool: "send_email",
      toolDefSha256: await toolDefinitionHash(manifest),
      args: base.args,
      target: "example.com",
      context: base.context,
      toolCallId: "call_1",
    });
    const tampered = canonical.replace("owner@example.com", "attacker@example.net");
    expect(await openApproval(tampered, bindingHash)).toBeNull();
    // Re-hashed tampering is caught by whoever holds the original hash; a non-canonical
    // spelling of the same envelope is refused even with its own hash.
    const spaced = canonical.replace(":", ": ");
    const spacedHash = toBase64Url(await sha256(new TextEncoder().encode(spaced)));
    expect(await openApproval(spaced, spacedHash)).toBeNull();
    expect(await openApproval("not json", bindingHash)).toBeNull();
  });
});

describe("batchDigest and stepUpChallenge (crypto review W1, W5)", () => {
  const a: BatchDecisionItem = {
    approvalId: "appr_a",
    bindingHash: "hash-a",
    decision: "approve",
    scope: "once",
  };
  const b: BatchDecisionItem = {
    approvalId: "appr_b",
    bindingHash: "hash-b",
    decision: "deny",
    scope: "once",
  };
  const items = [a, b];
  const digest = (decisions = [...items], batchId = "batch_1", userId = "user-a") =>
    batchDigest({ batchId, userId, decisions }).then(toBase64Url);

  it("changes with the order, a decision, a scope, the batch or the user", async () => {
    const d = await digest();
    const others = [
      await digest([b, a]),
      await digest([a, { ...b, decision: "approve" }]),
      await digest([{ ...a, scope: "hour" }, b]),
      await digest([a]),
      await digest([...items], "batch_2"),
      await digest([...items], "batch_1", "user-b"),
    ];
    for (const o of others) expect(o).not.toBe(d);
    expect(new Set(others).size).toBe(others.length);
  });

  it("derives the challenge from the digest and the nonce, in raw bytes", async () => {
    const d = await batchDigest({ batchId: "batch_1", userId: "user-a", decisions: [...items] });
    const nonce = new Uint8Array(32).fill(7);
    const challenge = await stepUpChallenge(d, nonce);
    const domain = new TextEncoder().encode("opa.approval-stepup.v1");
    const expected = await sha256(new Uint8Array([...domain, 0, ...d, ...nonce]));
    expect(challenge).toEqual(expected);
    expect(await stepUpChallenge(d, new Uint8Array(32).fill(8))).not.toEqual(challenge);
    await expect(stepUpChallenge(d, new Uint8Array(16))).rejects.toThrow(CanonicalError);
  });

  it("never equals a single approval's binding: a one-item batch uses the batch domain", async () => {
    const { bindingHash } = await bindApproval(base);
    const one = await batchDigest({
      batchId: "batch_1",
      userId: "user-a",
      decisions: [{ approvalId: "appr_a", bindingHash, decision: "approve", scope: "once" }],
    });
    expect(toBase64Url(one)).not.toBe(bindingHash);
  });
});
