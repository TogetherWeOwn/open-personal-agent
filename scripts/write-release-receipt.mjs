// SPDX-License-Identifier: Apache-2.0
// Writes the release receipt for a successful deploy-verify run (docs/releases.md).
// deploy-verify runs this after its real-account verification passes, then uploads the file as
// the `production-promotion-<sha>-<run_id>-<run_attempt>` artifact. The release workflow reads
// the receipt back and refuses to tag unless it binds the exact SHA, repository, workflow, job,
// run and attempt (scripts/release-promotion-proof.mjs). The receipt carries no secrets: it is
// an identity claim that only becomes evidence through GitHub's artifact metadata.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMain } from "./lib/repo.mjs";

export const VERIFY_WORKFLOW = ".github/workflows/deploy-verify.yml";
export const VERIFY_JOB = "verify";

const positiveId = (value) => (/^[1-9][0-9]*$/.test(value ?? "") ? value : null);

/** The receipt for the current Actions invocation, from the runner's own context. */
export function buildReceipt(env) {
  const sha = (env.GITHUB_SHA ?? "").toLowerCase();
  const receipt = {
    schema: 1,
    repository: env.GITHUB_REPOSITORY ?? "",
    workflow: VERIFY_WORKFLOW,
    job: VERIFY_JOB,
    sha,
    run_id: positiveId(env.GITHUB_RUN_ID),
    run_attempt: positiveId(env.GITHUB_RUN_ATTEMPT),
  };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(receipt.repository)) {
    throw new Error("GITHUB_REPOSITORY is missing or malformed");
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_SHA is not a full commit SHA");
  if (!receipt.run_id || !receipt.run_attempt) {
    throw new Error("GITHUB_RUN_ID / GITHUB_RUN_ATTEMPT are missing or malformed");
  }
  return receipt;
}

if (isMain(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/write-release-receipt.mjs <promotion.json path>");
    process.exitCode = 1;
  } else {
    const receipt = buildReceipt(process.env);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`release receipt for ${receipt.sha} written to ${target}`);
  }
}
