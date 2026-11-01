# Contributing

## Setup

Requirements: Node.js 22.12 or newer (`.nvmrc`) and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev                         # http://localhost:8787
```

## Before you open a pull request

- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. `pnpm check` runs the repository guards
  (ports rule, dependency guard, builder independence, supply chain). The README's command
  table lists the rest.
- Write commit subjects as [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat: …`, `fix(scope): …`). Release notes are grouped from those subjects, so a
  user-facing change with a non-conventional subject will not appear in them.
- Every GitHub Action is pinned to a full commit SHA, workflows default to
  `permissions: contents: read`, and new runtime dependencies need a security review before
  they ship in the Worker bundle. `pnpm check` enforces most of this;
  `scripts/check-supply-chain.mjs` lists the reviewed exceptions.

## Releases

Releases are calendar-versioned (`vYYYY.MDD.P`) tags with GitHub Release notes; `CHANGELOG.md`
is frozen and points to them. Contributors do not bump versions or edit a changelog. A
maintainer cuts a release after the commit passes CI and real-account deploy verification —
see [docs/releases.md](docs/releases.md).
