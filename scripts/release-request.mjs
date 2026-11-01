#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Builds the shared CalVer releaser's plan request for a release (docs/releases.md).
// The release job runs this, then plans and publishes vYYYY.MDD.P through
// TogetherWeOwn/.github/actions/calver (policy production-promotion). This script decides
// nothing about the version: it only proves the commit was certified. It proves the
// deploy-verify receipt and the CI run (scripts/release-promotion-proof.mjs) and hands the
// verified run, job and artifact identity to the releaser, which re-reads them from GitHub.
//
// Env: RELEASE_SHA (40-hex, on origin/main), GH_REPO, GH_TOKEN, GITHUB_OUTPUT,
// optional VERIFY_RUN_ID / VERIFY_RUN_ATTEMPT selectors (untrusted).
// Needs a full-history checkout and Python 3 for bounded receipt reads.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { isMain } from "./lib/repo.mjs";
import { verifyCi, verifyReleaseEvidence } from "./release-promotion-proof.mjs";
import { VERIFY_JOB, VERIFY_WORKFLOW } from "./write-release-receipt.mjs";

export function buildRequest({ sha, receipt, artifact }) {
  const runId = Number(receipt.run_id);
  const attempt = Number(receipt.run_attempt);
  return {
    phase: "plan",
    input: {
      channel: "stable",
      sha,
      // One certifying verify attempt is one release operation. A repair dispatch that
      // selects the same attempt recovers that attempt's frozen plan.
      operation: `deploy-verify-${runId}-${attempt}`,
      policy: "production-promotion",
      evidence: {
        runId,
        attempt,
        workflow: VERIFY_WORKFLOW,
        jobs: [VERIFY_JOB],
        artifactId: artifact.id,
        artifactName: artifact.name,
        artifactDigest: artifact.digest,
      },
    },
  };
}

function main() {
  const sha = (process.env.RELEASE_SHA || "").trim().toLowerCase();
  const repo = process.env.GH_REPO;
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("RELEASE_SHA must be a full 40-character commit SHA");
  }
  if (!repo) throw new Error("GH_REPO is required");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  } catch {
    throw new Error(`${sha} is not on origin/main; refusing to release it`);
  }
  verifyCi({ repo, sha });
  const { receipt, artifact } = verifyReleaseEvidence({ repo, sha });
  const request = JSON.stringify(buildRequest({ sha, receipt, artifact }));
  const line = `request=${request}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  process.stdout.write(line);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`::error title=release-request::${error.message}`);
    process.exitCode = 1;
  }
}
