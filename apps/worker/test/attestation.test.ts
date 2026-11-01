// SPDX-License-Identifier: Apache-2.0
// TWO-427 L-5 (M3-21 AC6 and AC8): every registration path takes only "none" attestation. Any
// other format is refused before the verifier runs, with no outbound request. A self-signed
// "packed" statement would verify if it reached the library.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { Browser, claim, count, env, freshDatabase, passkey, TOKEN } from "./helpers/app";
import type { AttestationFormat } from "./helpers/softauthn";

freshDatabase();

const ROTATED = "rotated-token-0123456789abcdefghijklm";
const rotated: Env = { ...env, OPA_SETUP_TOKEN: ROTATED };
const REFUSED: AttestationFormat[] = ["packed", "android-key"];

type Options = { options: { challenge: string } };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spies on `fetch` so a test can show the Worker made no outbound request. */
const watchFetch = () => vi.spyOn(globalThis, "fetch");

describe.each(REFUSED)("a %s attestation", (fmt) => {
  it("is refused at the claim, with no outbound fetch", async () => {
    const fetch = watchFetch();
    const res = await new Browser().setup(TOKEN, { fmt });
    expect([res.status, await res.json()]).toEqual([400, { error: "not_verified" }]);
    expect(fetch).not.toHaveBeenCalled();
    expect([await count("users"), await count("passkeys")]).toEqual([0, 0]);
  });

  it("is refused at recovery with a rotated setup token, with no outbound fetch", async () => {
    expect((await new Browser().setup(TOKEN)).status).toBe(200);
    const fetch = watchFetch();
    const res = await new Browser(rotated).setup(ROTATED, { fmt });
    expect([res.status, await res.json()]).toEqual([400, { error: "not_verified" }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await count("audit_log", "action = 'setup.recovery'")).toBe(0);
  });

  it("is refused at recovery with a code, with no outbound fetch", async () => {
    const { codes } = await claim();
    const br = new Browser();
    const res = await br.req("/api/auth/recover/options", { body: { code: codes[0] } });
    const { options } = await res.json<Options>();
    const credential = await passkey().create(options, { fmt });
    const fetch = watchFetch();
    const out = await br.req("/api/auth/recover", { body: { code: codes[0], credential } });
    expect([out.status, await out.json()]).toEqual([400, { error: "not_verified" }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await count("recovery_codes", "used_at IS NOT NULL")).toBe(0);
  });
});

it("still accepts a none attestation on every path", async () => {
  const { codes } = await claim();
  const br = new Browser();
  const res = await br.req("/api/auth/recover/options", { body: { code: codes[0] } });
  const credential = await passkey().create((await res.json<Options>()).options);
  expect((await br.req("/api/auth/recover", { body: { code: codes[0], credential } })).status).toBe(
    200,
  );
  expect((await new Browser(rotated).setup(ROTATED)).status).toBe(200);
});

it("refuses an attestation object that isn't CBOR or isn't a string", async () => {
  for (const attestationObject of ["AAAA", 42]) {
    const br = new Browser();
    const { options } = await (await br.options(TOKEN)).json<Options>();
    const credential = await passkey().create(options);
    credential.response.attestationObject = attestationObject as string;
    const res = await br.req("/setup", { body: { token: TOKEN, credential } });
    expect(res.status).toBe(400);
  }
  expect(await count("users")).toBe(0);
});
