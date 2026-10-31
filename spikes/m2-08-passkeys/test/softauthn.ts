// SPDX-License-Identifier: Apache-2.0
// A software passkey (ES256, "none" attestation) so both spikes run a real
// register + login ceremony inside workerd without a browser.

const enc = new TextEncoder();

export const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

// Minimal CBOR: unsigned/negative ints, byte strings, text strings, maps.
function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number): Uint8Array =>
    n < 24
      ? new Uint8Array([(major << 5) | n])
      : n < 256
        ? new Uint8Array([(major << 5) | 24, n])
        : new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  if (typeof v === "string") {
    const b = enc.encode(v);
    return cat(head(3, b.length), b);
  }
  if (v instanceof Map) {
    return cat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  }
  throw new Error("cbor: unsupported");
}

// WebCrypto ECDSA returns r||s; WebAuthn wants DER.
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let x = b.slice(i);
    if (x[0] & 0x80) x = cat(new Uint8Array([0]), x);
    return cat(new Uint8Array([0x02, x.length]), x);
  };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}

// Flags: UP (0x01) | UV (0x04) | BE (0x08) | BS (0x10); AT (0x40) on registration.
const FLAGS = 0x01 | 0x04 | 0x08 | 0x10;

export class SoftPasskey {
  private counter = 0;
  readonly credId = crypto.getRandomValues(new Uint8Array(16));
  private keys!: CryptoKeyPair;
  userHandle?: string;

  constructor(
    readonly rpId: string,
    readonly origin: string,
  ) {}

  // biome-ignore lint/suspicious/noExplicitAny: options JSON from either server
  async create(opts: any) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    this.userHandle = opts.user.id;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x as string)],
        [-3, fromB64url(jwk.y as string)],
      ]),
    );
    const authData = cat(
      await sha256(enc.encode(this.rpId)),
      new Uint8Array([FLAGS | 0x40, 0, 0, 0, 0]),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, this.credId.length]),
      this.credId,
      cose,
    );
    const clientDataJSON = enc.encode(
      JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: this.origin, crossOrigin: false }),
    );
    const attestationObject = cbor(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: options JSON from either server
  async get(opts: any, origin = this.origin, uv = true) {
    this.counter++;
    const c = this.counter;
    const authData = cat(
      await sha256(enc.encode(this.rpId)),
      new Uint8Array([uv ? FLAGS : FLAGS & ~0x04, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]),
    );
    const clientDataJSON = enc.encode(
      JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin, crossOrigin: false }),
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        cat(authData, await sha256(clientDataJSON)),
      ),
    );
    return {
      id: b64url(this.credId),
      rawId: b64url(this.credId),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(sig)),
        userHandle: this.userHandle,
      },
    };
  }
}
