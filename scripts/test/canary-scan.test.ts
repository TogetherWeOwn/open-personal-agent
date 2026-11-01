// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { findCanary } from "../canary-scan.mjs";

it("canary scan finds the canary plain or base64, and needs one", () => {
  const canary = "opa-canary-0123456789abcdef";
  const files = ["ok", `x${canary}y`, btoa(canary)].map((text, i) => ({ path: `f${i}`, text }));
  expect(findCanary(files, canary)).toEqual(["f1: contains the canary", "f2: contains the canary"]);
  expect(findCanary(files, undefined)).toHaveLength(1);
});

it("finds the canary base64-encoded at any offset inside a longer string", () => {
  const canary = "opa-canary-0123456789abcdef";
  for (const prefix of ["", "a", "ab", "abc"]) {
    for (const suffix of ["", "z", "zz"]) {
      const text = `{"v":"${btoa(prefix + canary + suffix)}"}`;
      expect(findCanary([{ path: "f", text }], canary), `${prefix}|${suffix}`).toHaveLength(1);
    }
  }
  expect(findCanary([{ path: "f", text: btoa("opa-canary-0123456789abcdeX") }], canary)).toEqual(
    [],
  );
});
