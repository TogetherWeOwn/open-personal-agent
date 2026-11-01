# Open Personal Agent

An open-source personal AI assistant that you deploy to your own Cloudflare account.

> **Status:** early skeleton. Nothing here is ready for real use yet.

## Develop locally

Requirements: Node.js 22.12 or newer, and pnpm (`corepack enable`).

```sh
pnpm install
cp .dev.vars.example .dev.vars   # then fill in the three values
pnpm dev                         # http://localhost:8787
```

`pnpm dev` builds the web app, applies `migrations/` to the local database and runs the Worker
locally with `wrangler dev`. It serves the app and `GET /api/health` without a Cloudflare account.
It serves the web app as built, so for live reload of web changes run `pnpm dev:web` alongside it
(Vite on port 5173, proxying `/api`).

`pnpm dev` also starts a mock OpenAI-compatible model server at `http://127.0.0.1:8788/v1`
(`pnpm dev:mock-model` starts it alone). It answers `GET /models` and streams an echo of your last
message from `POST /chat/completions`, so model calls need no API key and cost nothing. The web
chat still uses canned replies; once onboarding and the chat transport land, choose the
OpenAI-compatible option with that base URL.

### Run on Node (self-host)

`apps/node` runs the same app on Node.js 22.16 or newer without Cloudflare: `@hono/node-server`,
SQLite (`node:sqlite`) for the database, a local directory for files, and the same `migrations/`,
applied on start. Run `pnpm build`, then `pnpm start:node` with the three secrets from
`.dev.vars.example` in the environment. Data goes to `.opa-data/` (set `OPA_DATA_DIR` to move it).
It listens on `127.0.0.1:8787` (`OPA_HOST`, `PORT`); put a TLS-terminating proxy in front to
expose it. Workers AI and background tasks are Cloudflare-only for now, so `/api/health` reports
`degraded` on Node.

On Node, model providers can't reach private, loopback, link-local or cloud-metadata addresses, so
a base URL can't be used to read your network. To use a model server on the same machine or LAN
(Ollama, the mock server), set `OPA_ALLOW_PRIVATE_MODEL_HOSTS=1`.

| Command                           | What it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `pnpm test`                       | Vitest: unit tests in Node and Worker tests in the Workers runtime        |
| `pnpm lint`                       | Biome lint and format check                                               |
| `pnpm typecheck`                  | `tsc --noEmit` in every package                                           |
| `pnpm deploy:dry-run`             | Builds and bundles the Worker without deploying it                        |
| `pnpm test:harness`               | Boots the dry-run bundle with `createTestHarness` (run it after)          |
| `pnpm test:node`                  | Node adapters' storage contract, then boots `apps/node` (after `build`)   |
| `pnpm check`                      | Ports rule, dependency guard, builder independence, supply chain          |
| `pnpm notices`                    | Writes `dist/THIRD_PARTY_NOTICES.md` for production dependencies          |
| `pnpm --filter @opa/web test:e2e` | Playwright: axe, keyboard send and screenshot baselines (`visual` CI job) |

`GET /api/health` reports the schema version, each binding (D1, R2, the Durable Object, the
Workflow, Workers AI) and whether each secret is set, as booleans. While the database is
unmigrated or a secret is missing, it answers `setup_required` and `/setup` shows a **Finish
setup** page with the commands to run. `pnpm dev` applies the migrations locally on every start;
to apply them without starting it, run `npx wrangler d1 migrations apply DB --local`.

### Database changes

The schema lives in `packages/db/src/schema.ts` (Drizzle, SQLite dialect). After changing it, run
`pnpm --filter @opa/db generate --name <short_name>` to write the next SQL file into
`migrations/`. End that file with an `INSERT INTO schema_version` for the new version and bump
`SCHEMA_VERSION` in `packages/db/src/index.ts` to match. Migrations are forward-only, and an
applied migration is never edited.

## Deploy to Cloudflare

Requirements: a Cloudflare account on Workers Paid, with R2 enabled once in the dashboard.

```sh
pnpm install
pnpm wrangler login            # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
pnpm deploy:cloudflare         # --name <prefix> (or OPA_PREFIX) to deploy under another name
```

A re-run upgrades, or prints "Up to date"; `--dry-run` changes nothing on Cloudflare. A scoped
token needs the `required` entries in [`deploy/permissions.json`](deploy/permissions.json).

## Layout

- `wrangler.jsonc`: the single Worker and its bindings (D1, R2, Workers AI, the `Assistant` Durable
  Object, `TaskWorkflow`, a cron trigger and the static assets). Resource IDs are omitted, so
  wrangler provisions them on the first deploy.
- `apps/worker`: the Worker entry point (Hono API, Durable Object, Workflow, cron handler).
- `apps/web`: the single-page web app, served as static assets.
- `packages/db`: the Drizzle schema and database helpers.
- `migrations`: SQL migrations generated by drizzle-kit and applied by wrangler.
- `packages/*`: shared, runtime-agnostic packages.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
