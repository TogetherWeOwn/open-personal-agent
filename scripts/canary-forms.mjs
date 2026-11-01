// SPDX-License-Identifier: Apache-2.0
// No imports: the Worker test suite uses this too.

/**
 * The canary plain and in base64 at each of the three byte offsets it can start at inside a
 * longer string. Each form keeps only the characters that depend on the canary alone.
 */
export function canaryForms(canary) {
  const forms = [canary];
  for (let k = 0; k < 3; k++) {
    const encoded = btoa("\0".repeat(k) + canary).replace(/=+$/, "");
    const end = (k + canary.length) % 3 === 0 ? encoded.length : encoded.length - 1;
    forms.push(encoded.slice(k === 0 ? 0 : k + 1, end));
  }
  return forms;
}
