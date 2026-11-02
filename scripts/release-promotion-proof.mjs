// SPDX-License-Identifier: Apache-2.0
// Proves that a commit earned a release (docs/releases.md): a successful manually dispatched
// deploy-verify run on main at that exact commit, whose `verify` job ran the real-account
// verification and uploaded the attempt-bound receipt artifact, plus a successful CI run for
// the same commit. Only GitHub-authenticated run, job and artifact metadata can make an
// artifact a receipt; selectors and receipt JSON are untrusted, discovery is bounded, and
// every failure refuses. The shared CalVer releaser then re-reads the same run, job and
// artifact from GitHub before it writes anything.

import { execFileSync } from "node:child_process";
import { VERIFY_JOB, VERIFY_WORKFLOW } from "./write-release-receipt.mjs";

const CI_WORKFLOW = ".github/workflows/ci.yml";
// The verify job's steps that make a run a release certification, in order. Teardown-only
// runs skip all three, so they can never certify a release.
const STEPS = [
  "Verify (deploy, first run, re-run, upgrade, health, teardown)",
  "Record the release receipt",
  "Upload the release receipt",
];
const MAX_ARCHIVE = 64 * 1024;
const MAX_RECEIPT = 4096;
const MAX_ITEMS = 100;
const MAX_CANDIDATES = 20;

function requireProof(condition, reason) {
  if (!condition) throw new Error(`release proof refused: ${reason}`);
}

const id = (value) =>
  (Number.isSafeInteger(value) && value > 0) ||
  (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value))
    ? String(value)
    : null;

/** deploy-verify uploads the receipt under this name; the SHA in it binds run to commit. */
export function artifactName(sha, runId, attempt) {
  return `production-promotion-${sha}-${runId}-${attempt}`;
}

export function validateReceipt(receipt, { repo, sha, runId, attempt }) {
  requireProof(
    receipt &&
      receipt.schema === 1 &&
      receipt.repository === repo &&
      receipt.workflow === VERIFY_WORKFLOW &&
      receipt.job === VERIFY_JOB &&
      receipt.sha === sha &&
      receipt.run_id === runId &&
      receipt.run_attempt === attempt,
    "receipt does not bind the selected SHA, verify workflow, job and attempt",
  );
  return receipt;
}

function github(repo) {
  const deadline = Date.now() + 120_000;
  function command(program, args, maxBuffer, input) {
    const remaining = deadline - Date.now();
    requireProof(remaining > 0, "evidence time budget exhausted");
    try {
      return execFileSync(program, args, {
        input,
        maxBuffer,
        timeout: Math.min(15_000, remaining),
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const status = /HTTP (\d{3})/.exec(String(error.stderr || ""))?.[1];
      throw new Error(
        `release proof unreadable: ${program} failed${status ? ` (HTTP ${status})` : " or exceeded its bounds"}; not publishing`,
      );
    }
  }
  function api(route) {
    const bytes = command("gh", ["api", "--method", "GET", `repos/${repo}/${route}`], 1024 * 1024);
    try {
      const data = JSON.parse(bytes.toString("utf8"));
      requireProof(data && typeof data === "object" && !Array.isArray(data), "invalid API object");
      return data;
    } catch {
      throw new Error("release proof refused: malformed API response");
    }
  }
  function list(route, key) {
    // One explicitly bounded page. A partial page must never prove uniqueness or absence.
    const data = api(`${route}${route.includes("?") ? "&" : "?"}per_page=${MAX_ITEMS}&page=1`);
    requireProof(
      Number.isSafeInteger(data.total_count) &&
        data.total_count >= 0 &&
        data.total_count <= MAX_ITEMS &&
        Array.isArray(data[key]) &&
        data[key].length === data.total_count,
      `incomplete or exhausted ${key} listing`,
    );
    return data[key];
  }
  return { api, command, list };
}

function repositoryIdentity(repo) {
  requireProof(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
      repo === process.env.GITHUB_REPOSITORY &&
      id(process.env.GITHUB_REPOSITORY_ID),
    "missing repository invocation identity",
  );
  return process.env.GITHUB_REPOSITORY_ID;
}

/**
 * Finds and verifies the deploy-verify receipt for `sha`. Selectors (VERIFY_RUN_ID /
 * VERIFY_RUN_ATTEMPT) only narrow the search; the selected run is held to the same checks.
 * Returns the validated receipt and the artifact identity { id, name, digest } for the
 * shared releaser's evidence.
 */
export function verifyReleaseEvidence({ repo, sha }) {
  const repositoryId = repositoryIdentity(repo);
  const { api, command, list } = github(repo);
  const workflow = api("actions/workflows/deploy-verify.yml");
  requireProof(
    id(workflow.id) && workflow.path === VERIFY_WORKFLOW && workflow.state === "active",
    "wrong workflow identity",
  );

  function validateRun(run, runId, attempt) {
    requireProof(
      id(run.id) === runId &&
        id(run.run_attempt) === attempt &&
        id(run.workflow_id) === id(workflow.id) &&
        run.path === VERIFY_WORKFLOW &&
        run.repository?.full_name === repo &&
        id(run.repository?.id) === repositoryId &&
        run.head_repository?.full_name === repo &&
        id(run.head_repository?.id) === repositoryId &&
        run.head_branch === "main" &&
        run.head_sha === sha &&
        run.event === "workflow_dispatch" &&
        run.status === "completed" &&
        run.conclusion === "success",
      "wrong repository, workflow, main commit, run or attempt",
    );
  }

  function fromRun(runId, attempt) {
    const run = api(`actions/runs/${runId}/attempts/${attempt}`);
    validateRun(run, runId, attempt);
    const jobs = list(`actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs");
    const verifies = jobs.filter((job) => job.name === VERIFY_JOB);
    requireProof(verifies.length === 1, "missing or ambiguous verify job");
    const job = verifies[0];
    requireProof(
      id(job.id) &&
        id(job.run_id) === runId &&
        id(job.run_attempt) === attempt &&
        job.head_sha === sha &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        Array.isArray(job.steps) &&
        job.steps.length <= MAX_ITEMS,
      "verify job did not succeed in the selected attempt",
    );
    let previous = 0;
    for (const name of STEPS) {
      const matches = job.steps.filter((step) => step.name === name);
      const step = matches[0];
      requireProof(
        matches.length === 1 &&
          step.status === "completed" &&
          step.conclusion === "success" &&
          Number.isSafeInteger(step.number) &&
          step.number > previous,
        "verification, receipt and upload steps must succeed in order",
      );
      previous = step.number;
    }
    const name = artifactName(sha, runId, attempt);
    const artifacts = list(`actions/runs/${runId}/artifacts`, "artifacts").filter(
      (artifact) => artifact.name === name,
    );
    requireProof(artifacts.length === 1, "missing or ambiguous attempt-bound artifact");
    const artifact = artifacts[0];
    const producer = artifact.workflow_run;
    requireProof(
      id(artifact.id) &&
        artifact.expired === false &&
        Number.isSafeInteger(artifact.size_in_bytes) &&
        artifact.size_in_bytes > 0 &&
        artifact.size_in_bytes <= MAX_ARCHIVE &&
        (!artifact.expires_at || Date.parse(artifact.expires_at) > Date.now()) &&
        typeof artifact.digest === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(artifact.digest) &&
        id(producer?.id) === runId &&
        id(producer?.repository_id) === repositoryId &&
        id(producer?.head_repository_id) === repositoryId &&
        producer?.head_branch === "main" &&
        producer?.head_sha === sha,
      "expired, oversized or mismatched artifact producer metadata",
    );
    const archive = command(
      "gh",
      ["api", "--method", "GET", `repos/${repo}/actions/artifacts/${id(artifact.id)}/zip`],
      MAX_ARCHIVE,
    );
    // Read the fixed bounded member in memory; never extract an artifact to disk.
    const bytes = command(
      "python3",
      [new URL("./read-release-receipt.py", import.meta.url).pathname],
      MAX_RECEIPT,
      archive,
    );
    let receipt;
    try {
      receipt = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("release proof refused: malformed receipt JSON");
    }
    validateReceipt(receipt, { repo, sha, runId, attempt });
    // The shared CalVer releaser re-reads this exact artifact by ID and digest.
    return {
      receipt,
      artifact: { id: Number(artifact.id), name: artifact.name, digest: artifact.digest },
    };
  }

  const hint = process.env.VERIFY_RUN_ID || "";
  const attemptHint = process.env.VERIFY_RUN_ATTEMPT || "";
  if (hint || attemptHint) {
    requireProof(
      id(hint) && id(attemptHint),
      "both run and attempt selectors must be positive decimal IDs",
    );
    return fromRun(hint, attemptHint);
  }
  // Runs at this exact commit only: the receipt binds the verified SHA, so a run that
  // verified another commit is skipped here rather than refused.
  const runs = list(`actions/runs?head_sha=${sha}`, "workflow_runs");
  let candidates = 0;
  for (const run of runs) {
    if (run.path !== VERIFY_WORKFLOW || run.event !== "workflow_dispatch") continue;
    if (run.head_branch !== "main" || run.status !== "completed" || run.conclusion !== "success") {
      continue;
    }
    requireProof(++candidates <= MAX_CANDIDATES, "candidate budget exhausted; select a run");
    const runId = id(run.id);
    const attempt = id(run.run_attempt);
    requireProof(runId && attempt, "invalid discovered run identity");
    const artifacts = list(`actions/runs/${runId}/artifacts`, "artifacts");
    if (!artifacts.some((artifact) => artifact.name === artifactName(sha, runId, attempt))) {
      continue;
    }
    // fromRun still fails closed if the receipt inside disagrees with the name.
    return fromRun(runId, attempt);
  }
  throw new Error(
    "release proof refused: no successful deploy-verify run with a receipt for this commit; not publishing",
  );
}

/** Requires a completed successful CI push run for the exact commit on main. */
export function verifyCi({ repo, sha }) {
  const repositoryId = repositoryIdentity(repo);
  const { list } = github(repo);
  const runs = list(`actions/runs?head_sha=${sha}`, "workflow_runs");
  const passed = runs.some(
    (run) =>
      run.path === CI_WORKFLOW &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.head_sha === sha &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      id(run.repository?.id) === repositoryId &&
      id(run.head_repository?.id) === repositoryId,
  );
  requireProof(passed, "no successful CI run for this commit on main");
}
