// SPDX-License-Identifier: Apache-2.0
// AAD encodings (ADR 0010 D4). Internal: nothing here is re-exported.
//
// v2 is a domain tag and then each field as a 4-byte big-endian length and its UTF-8 bytes, so no
// field value can shift a boundary. v1 joined the fields with `|`; it is read, and written for a
// user whose DEK is still v1, until a rotation re-keys that user. A DEK's format is its secrets'.
import { vaultError } from "./kek";

type Bytes = Uint8Array<ArrayBuffer>;
export type AadFormat = 1 | 2;

const encoder = new TextEncoder();
const DOMAINS = { dek: "opa/dek/v2", secret: "opa/secret/v2" } as const;

/** A positive safe integer, as a decimal string: D1 hands back versions untyped. */
function counter(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw vaultError("invalid_input");
  return String(value);
}

function encode(format: AadFormat, domain: keyof typeof DOMAINS, fields: string[]): Bytes {
  if (format === 1) return new Uint8Array(encoder.encode(fields.join("|")));
  const parts = [DOMAINS[domain], ...fields].map((f) => encoder.encode(f));
  const out = new Uint8Array(parts.reduce((n, p) => n + 4 + p.length, 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const part of parts) {
    view.setUint32(at, part.length);
    out.set(part, at + 4);
    at += 4 + part.length;
  }
  return out;
}

/** The AAD a DEK is wrapped with under KEK epoch `kekVersion`. */
export function dekAad(format: AadFormat, userId: string, kekVersion: number): Bytes {
  return encode(format, "dek", [userId, counter(kekVersion)]);
}

/** The AAD a secret is sealed with. `binding` may contain `|`; v1 stays unambiguous as it is last but one. */
export function secretAad(
  format: AadFormat,
  s: { userId: string; id: string; purpose: string; binding: string; version: number },
): Bytes {
  return encode(format, "secret", [s.userId, s.id, s.purpose, s.binding, counter(s.version)]);
}
