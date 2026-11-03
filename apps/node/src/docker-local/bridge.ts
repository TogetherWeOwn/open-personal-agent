// SPDX-License-Identifier: Apache-2.0
// The proxy-token bridge (M4-05 AC4, M4-00a §4.0): the capability token lives only in this
// object's memory — never the image, a snapshot, a disk, an exec command line, a URL or a
// log — and is revoked on stop/destroy. M4-00a mints and verifies the token; this module
// only holds it for the computer's lifetime and hands it to the call-time injection the
// control channel performs (exec stdin / provider file write, never argv). One bridge per
// computer, dropped with the computer.
export class TokenBridge {
  private token: string | null = null;

  /** Holds the token for one computer. Double-attach is a caller bug and throws. */
  attach(token: string): void {
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("token bridge: token must be a non-empty string");
    }
    if (this.token !== null) throw new Error("token bridge: already attached");
    this.token = token;
  }

  /** Whether a live token is held. */
  get attached(): boolean {
    return this.token !== null;
  }

  /**
   * The token for a single call-time injection. The caller must never store, log or
   * interpolate the return into argv/URLs — it rides exec stdin or a file write only.
   */
  take(): string {
    if (this.token === null) throw new Error("token bridge: no token attached");
    return this.token;
  }

  /** Revokes the token: overwrites the reference so nothing dangles after stop/destroy. */
  revoke(): void {
    this.token = null;
  }

  /**
   * Loud failure instead of a leak: serializing a bridge (into a log line, an audit row, a
   * snapshot payload) throws rather than writing the token somewhere it outlives the
   * computer.
   */
  toJSON(): never {
    throw new Error("token bridge: must never be serialized");
  }
}
