// SPDX-License-Identifier: Apache-2.0
// A software passkey (ES256, "none" attestation) so tests run a real registration ceremony
// inside workerd without a browser. Taken from the M2-08 spike; login (`get`) lands with M2-10.
import { base64url } from "../../src/auth";

const encoder = new TextEncoder();

function fromBase64url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (ch) =>
    ch.charCodeAt(0),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Minimal CBOR: integers, byte strings, text strings and maps.
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number) =>
    n < 24
      ? new Uint8Array([(major << 5) | n])
      : n < 256
        ? new Uint8Array([(major << 5) | 24, n])
        : new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Map) {
    return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
  }
  throw new Error("cbor: unsupported value");
}

// UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10) | AT (0x40).
const FLAGS = 0x01 | 0x04 | 0x08 | 0x10 | 0x40;

export class SoftPasskey {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {}

  /** Answers `navigator.credentials.create()` for `options`, with or without user verification. */
  async create(options: { challenge: string }, { uv = true, origin = this.origin } = {}) {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64url(jwk.x as string)],
        [-3, fromBase64url(jwk.y as string)],
      ]),
    );
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(this.rpId)),
    );
    const authData = concat(
      rpIdHash,
      new Uint8Array([uv ? FLAGS : FLAGS & ~0x04, 0, 0, 0, 0]),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cose,
    );
    const clientData = encoder.encode(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }),
    );
    const attestation = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: base64url(this.credentialId),
      rawId: base64url(this.credentialId),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientData),
        attestationObject: base64url(attestation),
        transports: ["internal"],
      },
    };
  }
}
