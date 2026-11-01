# Acceptance-test traceability

The project's 11 non-negotiable acceptance tests, the check that shows each one and where that
check lives. QA keeps this table current: a row changes when its check lands or moves.

| #   | Test                    | What must be shown                                                             | Check                                                                                                                         | Milestone           | Where now                                                                                        |
| --- | ----------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Deployment independence | A new user deploys to Workers Paid without the builders' tools or accounts     | Scripted fresh-account deploy from a public fork, by a run with no builder credentials; CI dependency check for builder tools | M2                  | `scripts/check-builder-independence.mjs` (CI `builder-independence`); fresh-account deploy: open |
| 2   | Easy deployment         | Resources are provisioned by a simple, documented, reproducible process        | `pnpm deploy:cloudflare` smoke test: fresh, re-run, upgrade, teardown, with timings and prompt counts                         | M2                  | `deploy-verify.yml`; `acceptance/deployment.spec.ts` against the deployed `BASE_URL`             |
| 3   | Cost transparency       | Install docs separate the Workers Paid baseline from other charges             | M2: docs lint for the README cost section and the deploy cost line. M3: Playwright on the Usage page                          | M2 (docs), M3 (app) | `scripts/check-docs-cost.mjs` (CI `docs-cost-lint`); Usage page: M3                              |
| 4   | Builder independence    | The app works without the development session that built it                    | The full suite in a clean runner with only documented env; import, URL and env denylist                                       | M2                  | CI `builder-independence` (`env -i pnpm test`); CI `e2e` (clean container)                       |
| 5   | Agent functionality     | A user connects a compatible model and completes a real agent task             | E2E: connect a provider (recorded fixtures in CI, one live run per release), complete a task, artifact present                | M3                  | M2 covers connecting a model and a chat turn: `test/e2e/persistence.spec.ts`                     |
| 6   | Provider separation     | Model provider, harness and computer provider have separate config and ports   | Static check: three ports, no cross-imports. E2E: change each axis, the other two stay unchanged                              | M4, gate at M5      | `scripts/check-boundaries.mjs` (ports rule); E2E: M4                                             |
| 7   | Computer functionality  | A supported computer adapter runs a genuine task, not a mock                   | E2E on Cloudflare Sandbox and docker-local, output verified                                                                   | M4                  | Open                                                                                             |
| 8   | Extensibility           | The user adds and uses a supported MCP server through documented configuration | E2E: follow the docs to add a reference remote MCP server, call a tool, see the card and approval                             | M5                  | Open                                                                                             |
| 9   | Persistence             | Conversations and tasks survive application restarts                           | Create conversations (M3: and a running task), restart and evict the Durable Object, assert everything is intact              | M2 (chats), M3      | Conversations: `test/e2e/persistence.spec.ts` (CI `e2e`). Tasks: M3                              |
| 10  | Security                | A user can't reach another user's memory, credentials, sessions or computers   | Data isolation with two seeded users (M3); computer isolation (M4)                                                            | M3, M4              | Partial: worker tests of scoped access and sessions (`apps/worker/test`); two-user suite: M3     |
| 11  | Portability             | Runs locally, with a credible alternative hosting path                         | M2: `pnpm dev` local run. M3: Node smoke test. M7: `docker compose up` E2E                                                    | M2, M3, M7          | Local: CI `e2e` and `acceptance/` on `wrangler dev`; Node: CI `selfhost-parity`; Docker: M7      |

Features that need an additional paid service must name it and its price in Settings and in the
docs.

## Running the suites

- `pnpm build && pnpm test:e2e` runs both Playwright projects on local stacks: `e2e` claims a fresh
  deployment with a virtual passkey, onboards with the mock model, chats, reloads, and restarts
  `wrangler dev` on the same state (which evicts the Durable Object); `acceptance` runs the read-only
  checks on a local stack.
- `BASE_URL=https://your-assistant.example pnpm test:acceptance` runs the read-only acceptance
  checks against a deployment. They need no secrets and change nothing.
