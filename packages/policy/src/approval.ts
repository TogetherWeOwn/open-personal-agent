// SPDX-License-Identifier: Apache-2.0
// The approval binding and its step-up challenge (M3-07 AC1, AC4, AC11; ADR 0010 D9; crypto
// review C1-C6, W1, W5). What the user saw, what the hash covers and what runs are the
// same bytes: the host stores the canonical envelope on the approval row and executes the
// arguments parsed back out of it. Everything is SHA-256 over RFC 8785 (JCS) bytes; no secret
// key, since the server recomputes every hash from its own rows.
import type { ApprovalScope } from "./decide";
import type { ToolManifest } from "./manifest";

/** A value JCS can't represent without changing it: refused, never coerced (crypto review C3). */
export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

/** How deep and how large a canonical value may be; the model controls tool arguments. */
export const CANONICAL_LIMITS = { depth: 32, bytes: 64 * 1024 } as const;

// With the `u` flag a surrogate pair is one code point, so this matches only a lone half.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

const isPlainObject = (v: object) => {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function encode(value: unknown, depth: number): string {
  if (depth > CANONICAL_LIMITS.depth) throw new CanonicalError("the value is nested too deeply");
  if (value === null || value === true || value === false) return String(value);
  if (typeof value === "number") {
    // JCS serialises numbers with ECMAScript's Number::toString, which is JSON.stringify's.
    // NaN and Infinity have no JSON form: JSON.stringify would quietly write `null`. (Integers
    // past 2^53 are refused where tool input is parsed, before they could be rounded.)
    if (!Number.isFinite(value)) throw new CanonicalError("numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new CanonicalError("strings must be well-formed Unicode");
    return JSON.stringify(value); // lowercase \u00xx for controls, as RFC 8785 §3.2.2.2
  }
  if (Array.isArray(value)) return `[${value.map((v) => encode(v, depth + 1)).join(",")}]`;
  if (typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    // The default sort compares UTF-16 code units, which is the order RFC 8785 §3.2.3 asks for.
    const keys = Object.keys(record).sort();
    const members = keys.map((k) => {
      if (LONE_SURROGATE.test(k)) throw new CanonicalError("keys must be well-formed Unicode");
      if (record[k] === undefined) throw new CanonicalError(`"${k}" has no JSON value`);
      return `${JSON.stringify(k)}:${encode(record[k], depth + 1)}`;
    });
    return `{${members.join(",")}}`;
  }
  throw new CanonicalError(`a ${typeof value} has no JSON value`);
}

/** RFC 8785 JSON Canonicalization Scheme. Throws `CanonicalError` rather than change a value. */
export function jcs(value: unknown): string {
  const text = encode(value, 0);
  if (utf8.encode(text).length > CANONICAL_LIMITS.bytes) {
    throw new CanonicalError("the value is too large");
  }
  return text;
}

const utf8 = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** The one string form of a hash or nonce: base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new CanonicalError("not base64url");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** What the approval belongs to. Tagged, so a turn's id can never stand in for a task's (C2). */
export type ApprovalContext =
  | { kind: "turn"; id: string; conversationId: string }
  | { kind: "task"; id: string; conversationId: string };

export const APPROVAL_DOMAIN = "opa.approval.v1";
export const BATCH_DOMAIN = "opa.approval-batch.v1";
export const STEP_UP_DOMAIN = "opa.approval-stepup.v1";

/**
 * The hash of a tool's definition: an update to the tool between approval and execution changes
 * the binding instead of quietly changing what the approved call does (C2).
 */
export async function toolDefinitionHash(manifest: ToolManifest): Promise<string> {
  return toBase64Url(await sha256(utf8.encode(jcs(manifest))));
}

export type ApprovalBindingInput = {
  userId: string;
  manifest: ToolManifest;
  args: Record<string, unknown>; // schema-validated (M3-03 AC2), never raw model JSON
  target: string | null; // derived by the server from `args` (C5)
  context: ApprovalContext;
  toolCallId: string; // per occurrence: two identical calls in one turn bind differently
};

/** The envelope as JCS text, and its hash. The row stores both; execution re-hashes the text. */
export async function bindApproval(
  input: ApprovalBindingInput,
): Promise<{ canonical: string; bindingHash: string }> {
  const { context } = input;
  const canonical = jcs({
    v: 1,
    domain: APPROVAL_DOMAIN,
    user_id: input.userId,
    tool: input.manifest.name,
    tool_def_sha256: await toolDefinitionHash(input.manifest),
    args: input.args,
    target: input.target,
    context: { kind: context.kind, id: context.id, conversation_id: context.conversationId },
    tool_call_id: input.toolCallId,
  });
  return { canonical, bindingHash: toBase64Url(await sha256(utf8.encode(canonical))) };
}

/** The parts of a stored envelope that execution and the re-check read back. */
export type ApprovalEnvelope = {
  userId: string;
  tool: string;
  toolDefSha256: string;
  args: Record<string, unknown>;
  target: string | null;
  context: ApprovalContext;
  toolCallId: string;
};

/**
 * The stored envelope, if `canonical` still hashes to `bindingHash` and is one this code wrote
 * (canonical form, this domain and version). `null` for anything else: the caller denies.
 */
export async function openApproval(
  canonical: string,
  bindingHash: string,
): Promise<ApprovalEnvelope | null> {
  try {
    const actual = toBase64Url(await sha256(utf8.encode(canonical)));
    if (actual !== bindingHash) return null;
    const e = JSON.parse(canonical) as Record<string, unknown>;
    if (jcs(e) !== canonical || e.v !== 1 || e.domain !== APPROVAL_DOMAIN) return null;
    const ctx = e.context as Record<string, unknown> | null;
    const args = e.args;
    if (
      typeof e.user_id !== "string" ||
      typeof e.tool !== "string" ||
      typeof e.tool_def_sha256 !== "string" ||
      typeof e.tool_call_id !== "string" ||
      (e.target !== null && typeof e.target !== "string") ||
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !ctx ||
      (ctx.kind !== "turn" && ctx.kind !== "task") ||
      typeof ctx.id !== "string" ||
      typeof ctx.conversation_id !== "string"
    ) {
      return null;
    }
    return {
      userId: e.user_id,
      tool: e.tool,
      toolDefSha256: e.tool_def_sha256,
      args: args as Record<string, unknown>,
      target: e.target as string | null,
      context: { kind: ctx.kind, id: ctx.id, conversationId: ctx.conversation_id },
      toolCallId: e.tool_call_id,
    };
  } catch {
    return null;
  }
}

/** One item of a submitted batch decision, as the passkey signs it (W5). */
export type BatchDecisionItem = {
  approvalId: string;
  bindingHash: string;
  decision: "approve" | "deny";
  scope: ApprovalScope;
};

/**
 * The digest of the exact decision set a step-up signs: the batch, the user, and every item's
 * id, binding hash, decision and scope, in the batch's stored order (W5). A flipped decision or
 * scope, a reordering or a missing item is a different digest.
 */
export async function batchDigest(input: {
  batchId: string;
  userId: string;
  decisions: readonly BatchDecisionItem[];
}): Promise<Uint8Array> {
  const envelope = jcs({
    v: 1,
    domain: BATCH_DOMAIN,
    batch_id: input.batchId,
    user_id: input.userId,
    decisions: input.decisions.map((d) => ({
      approval_id: d.approvalId,
      binding_hash: d.bindingHash,
      decision: d.decision,
      scope: d.scope,
    })),
  });
  return sha256(utf8.encode(envelope));
}

/** 32 bytes from the CSPRNG: the ceremony's nonce (W2). */
export function newNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * The WebAuthn challenge for a batch step-up, in raw bytes (W1):
 * SHA-256("opa.approval-stepup.v1" ‖ 0x00 ‖ batch digest ‖ nonce). Pass it to the WebAuthn
 * library as bytes; a string challenge would be UTF-8 encoded and sign other bytes.
 */
export async function stepUpChallenge(digest: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (digest.length !== 32 || nonce.length !== 32) {
    throw new CanonicalError("the digest and the nonce must be 32 bytes each");
  }
  const domain = utf8.encode(STEP_UP_DOMAIN);
  const input = new Uint8Array(domain.length + 1 + 64);
  input.set(domain, 0);
  input[domain.length] = 0;
  input.set(digest, domain.length + 1);
  input.set(nonce, domain.length + 33);
  return sha256(input);
}
