// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { artifactName, validateReceipt } from "../release-promotion-proof.mjs";
import { buildRequest } from "../release-request.mjs";
import { buildReceipt } from "../write-release-receipt.mjs";

const SHA = "a".repeat(40);
const REPO = "TogetherWeOwn/open-personal-agent";
const ENV = {
  GITHUB_REPOSITORY: REPO,
  GITHUB_SHA: SHA.toUpperCase(),
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "2",
};
const RECEIPT = {
  schema: 1,
  repository: REPO,
  workflow: ".github/workflows/deploy-verify.yml",
  job: "verify",
  sha: SHA,
  run_id: "12345",
  run_attempt: "2",
};
const BOUND = { repo: REPO, sha: SHA, runId: "12345", attempt: "2" };

describe("release receipt", () => {
  it("builds the receipt from the runner context, lowercasing the SHA", () => {
    expect(buildReceipt(ENV)).toEqual(RECEIPT);
  });

  it("refuses a malformed runner context", () => {
    expect(() => buildReceipt({ ...ENV, GITHUB_REPOSITORY: "noslash" })).toThrow(/REPOSITORY/);
    expect(() => buildReceipt({ ...ENV, GITHUB_SHA: "abc" })).toThrow(/GITHUB_SHA/);
    expect(() => buildReceipt({ ...ENV, GITHUB_RUN_ID: "0" })).toThrow(/RUN_ID/);
    expect(() => buildReceipt({ ...ENV, GITHUB_RUN_ATTEMPT: "" })).toThrow(/RUN_ATTEMPT/);
  });

  it("names the artifact with the SHA as its own token", () => {
    expect(artifactName(SHA, "12345", "2")).toBe(`production-promotion-${SHA}-12345-2`);
  });

  it("accepts only a receipt bound to the selected run, attempt and commit", () => {
    expect(validateReceipt(RECEIPT, BOUND)).toBe(RECEIPT);
    for (const patch of [
      { schema: 2 },
      { repository: "TogetherWeOwn/other" },
      { workflow: ".github/workflows/ci.yml" },
      { job: "ci" },
      { sha: "b".repeat(40) },
      { run_id: "999" },
      { run_attempt: "1" },
    ]) {
      expect(() => validateReceipt({ ...RECEIPT, ...patch }, BOUND)).toThrow(/refused/);
    }
    expect(() => validateReceipt(null, BOUND)).toThrow(/refused/);
  });
});

describe("release request", () => {
  it("builds a production-promotion plan request from the proven evidence", () => {
    const artifact = {
      id: 777,
      name: artifactName(SHA, "12345", "2"),
      digest: `sha256:${"c".repeat(64)}`,
    };
    expect(buildRequest({ sha: SHA, receipt: RECEIPT, artifact })).toEqual({
      phase: "plan",
      input: {
        channel: "stable",
        sha: SHA,
        operation: "deploy-verify-12345-2",
        policy: "production-promotion",
        evidence: {
          runId: 12345,
          attempt: 2,
          workflow: ".github/workflows/deploy-verify.yml",
          jobs: ["verify"],
          artifactId: 777,
          artifactName: artifact.name,
          artifactDigest: artifact.digest,
        },
      },
    });
  });
});
