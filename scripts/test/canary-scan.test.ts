// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { findCanary } from "../canary-scan.mjs";

it("canary scan finds the canary plain or base64, and needs one", () => {
  const canary = "opa-canary-0123456789abcdef";
  const files = ["ok", `x${canary}y`, btoa(canary)].map((text, i) => ({ path: `f${i}`, text }));
  expect(findCanary(files, canary)).toEqual(["f1: contains the canary", "f2: contains the canary"]);
  expect(findCanary(files, undefined)).toHaveLength(1);
});
