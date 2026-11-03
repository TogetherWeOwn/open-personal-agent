<!-- SPDX-License-Identifier: Apache-2.0 -->
# Shared computer image

The only image a computer boots (M4-04 AC5, built with M4-05; owned by M4-05 until M4-04
lands). Both adapters — Cloudflare Sandbox (Configuration B) and docker-local
(Configuration C) — run this image, referenced **by digest only**.

## Pins

`pins.json` is the lockfile: base image digest, CLI versions, computer uid. `Dockerfile`
takes the same values as build args (defaults equal the pins) so a build from this
directory with no args reproduces the pinned image; the M4-05 docker-gated tests assert
the built image reports the pinned `node`, `npm` and `git` versions.

## Runtime reference

Adapters never use a floating tag. The reference is
`node:22-alpine@sha256:fe4f...9914` (full digest in `pins.json`) plus this layer's own
digest once published. Local builds tag `opa-computer:<pins-hash>` for caching only —
the provider resolves the digest before create and refuses a tag-only reference.

## What is (and is not) in the image

- In: the task runtime — node, npm, git — and a non-root `computer` user (uid 10000)
  with a `/work` directory.
- Never in: capability tokens, session cookies, model keys, wider-audience tokens,
  host mounts, or the Docker socket. The capability token rides the control channel
  into the bridge process's memory only (M4-05 AC4) and is revoked on stop/destroy.
