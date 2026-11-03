// SPDX-License-Identifier: Apache-2.0
// The shared computer image reference (M4-05 AC1, M4-04 AC5): the only image a computer
// boots, referenced by digest only — never a floating tag, never `latest`. The pins live in
// `computers/image/pins.json` (the Dockerfile builds from the same values); this module is
// the adapter's compile-time view of them so create() refuses a tag-only reference even if
// a caller passes one.
import pins from "../../../../computers/image/pins.json";

/** `node:22-alpine` pinned by digest: the base every computer boots. */
export const COMPUTER_BASE_REF = `${pins.base}@${pins.baseDigest}` as const;

/** The computer uid the image creates (D5: non-root by construction). */
export const COMPUTER_UID = pins.computerUser.uid as number;

/** The pinned package versions the docker-gated tests assert inside a booted computer. */
export const COMPUTER_PINS = {
  git: pins.packages.git,
  node: pins.baseDetail.node,
  npm: pins.baseDetail.npm,
} as const;

/** Local build tag (cache only): the provider resolves the digest before create. */
export function computerLocalTag(): string {
  const hex = pins.baseDigest.replace(/^sha256:/, "");
  return `opa-computer:${hex.slice(0, 12)}`;
}
