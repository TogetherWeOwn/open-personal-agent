# Spike M2-08: passkey library on workerd and D1

Throwaway. Not part of the product build and never merged to `main`.

Compares two ways to do ADR 0010 D2 (passkeys first, our session rules):

- **A** `a/`: `@simplewebauthn/server` 14.0.3 for the WebAuthn ceremony, plus our own
  session layer on D1 (hashed opaque IDs, `__Host-` cookie, exact-Origin check,
  30 d idle / 90 d absolute, sign out everywhere). About 190 lines.
- **B** `b/`: `better-auth` 1.7.14 with `@better-auth/passkey` 1.7.14, passkey-first,
  on D1 through better-auth's native D1 dialect.

`test/softauthn.ts` is a software passkey (ES256, `none` attestation), so both run a
real register and login ceremony inside workerd through `@cloudflare/vitest-plugin`.

```sh
pnpm install --ignore-workspace
pnpm test                                    # 10 tests, both variants
npx wrangler deploy --dry-run --minify -c a/wrangler.jsonc --outdir dist   # size
```

## Results (2026-10-31)

| | Baseline (Hono only) | A: SimpleWebAuthn + own | B: better-auth + passkey |
|---|---|---|---|
| Worker size, minified (gzip) | 20 KiB (8 KiB) | 363 KiB (103 KiB) | 1,143 KiB (317 KiB) |
| Worker size, unminified (gzip) | 61 KiB (15 KiB) | 775 KiB (144 KiB) | 2,590 KiB (467 KiB) |
| Runtime packages (transitive) | 0 | 16 | ~41 |
| Needs `nodejs_compat` | no | no | no |
| Register + login on workerd/D1 | | pass | pass |
| Enforces user verification | | yes | **no** (hard-coded `false`) |
| Session ID stored in D1 | | SHA-256 hash | **plaintext** token |
| Cookie | | `__Host-opa_session` | `__Secure-better-auth.session_token` |
| 90 d absolute timeout | | yes | no (sliding `expiresIn` only) |
| Atomic register (user + passkey + session) | | `D1.batch` | no (D1 dialect has no transactions) |
| Reads `process.env` generically | | no | yes (env proxy in `@better-auth/core`) |

The decision note lives on the M2-08 card.
