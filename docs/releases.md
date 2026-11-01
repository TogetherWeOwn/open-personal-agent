# Releases

Releases use calendar versions: **`vYYYY.MDD.P`** (for example `v2026.1101.0`). The version is
the UTC date of the release plus a patch counter for that day, starting at 0. There is no
release commit and no version-bump pull request; the version is computed from the existing
tags when the release is published, and `package.json` versions are never rewritten. Release
notes live on the GitHub Release and are grouped from [Conventional Commit](https://www.conventionalcommits.org/)
subjects since the previous release tag, so write commit subjects in that form
(`feat: …`, `fix(scope): …`) for user-facing changes to appear in the notes. `CHANGELOG.md`
is frozen history and points here.

## How a commit earns a release

Every deployment runs on the account of the person who deploys, so a release is a statement
about this repository: the tagged commit passed the gates and was verified on a real account.
Two gates, in order:

1. **CI** — the `ci` workflow's push run on `main` for the exact commit concluded successfully.
2. **Deploy verification** — a manually dispatched
   [`deploy-verify`](../.github/workflows/deploy-verify.yml) run on `main` at the exact commit
   passed (deploy, first run, re-run, upgrade, health; see [deploy/VERIFY.md](../deploy/VERIFY.md)).
   Each run waits for the `cf-verify` environment reviewer. After the verification passes, the
   run uploads a receipt artifact named `production-promotion-<sha>-<run_id>-<run_attempt>`.

## Cutting a release

1. Run **Actions → deploy-verify → Run workflow** on `main`, and approve the `cf-verify`
   environment. Note the commit SHA the run verified (its head commit).
2. Run **Actions → release → Run workflow** with that full 40-hex `sha` and **`dry_run: true`**.
   The job proves the evidence (green CI, the verify run, job, steps and receipt, all re-read
   from GitHub), plans the version and prints it without writing anything.
3. Run it again with **`dry_run: false`**. The job tags the verified commit `vYYYY.MDD.P` and
   publishes the GitHub Release as **Latest**. Check the release on the Releases page.

The receipt artifact is kept for 90 days, so cut the release within that window or run
deploy-verify again. If several successful verify runs certify the commit, the release uses
the newest; pass `verify_run_id` and `verify_run_attempt` to select a specific one (the
selector only narrows the search — the selected run must pass the same proof).

Nothing about tagging proves a rollout: the tag records that the commit was certified, and
people deploy the release themselves.

## Skips, rollback and repair

- **Re-release of a tagged commit** skips green: a commit that already carries a stable tag is
  not a new release.
- **Rollback** (a commit older than the newest stable tag) also skips green and never moves
  Latest backwards. To roll a deployment back, deploy the previous release tag; the release
  workflow is not involved. A rollback does not undo database migrations — migrations are
  forward-only (see the README's database section), so keep them backwards-compatible.
- **Repair** a tag whose GitHub Release is missing by dispatching `release` again for the same
  commit with the same verify run selected and **`repair: true`**. The repair recovers that
  attempt's frozen plan instead of allocating a new version.

## The tooling

Tagging and notes come from the shared CalVer releaser (`TogetherWeOwn/.github`,
`actions/calver`, policy `production-promotion`), pinned to a reviewed commit in
[`.github/workflows/release.yml`](../.github/workflows/release.yml). This repository's part is
the proof: `scripts/write-release-receipt.mjs` writes the receipt,
`scripts/release-promotion-proof.mjs` verifies the evidence and
`scripts/release-request.mjs` hands it to the releaser. The release job is the only job in
this repository allowed write permissions (`contents: write` for the tag and the Release,
`actions: read` for the evidence), recorded as a reviewed exception in
`scripts/check-supply-chain.mjs` (`REVIEWED_WRITE_JOBS`).
