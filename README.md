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
message from `POST /chat/completions`, so model calls accept any API key and cost nothing. The web
chat still uses canned replies; once onboarding and the chat transport land, choose the
OpenAI-compatible option with that base URL. Base URLs must use `https://`, except that a server on
this machine (`localhost`, `127.0.0.1`, `[::1]`) may use `http://` (on Node, see below).

### Run on Node (self-host)

`apps/node` runs the same app on Node.js 22.16 or newer without Cloudflare: `@hono/node-server`,
SQLite (`node:sqlite`) for the database, a local directory for files, and the same `migrations/`,
applied on start. Run `pnpm build`, then `pnpm start:node` with the three secrets from
`.dev.vars.example` in the environment. Data goes to `.opa-data/` (set `OPA_DATA_DIR` to move it).
It listens on `127.0.0.1:8787` (`OPA_HOST`, `PORT`); put a TLS-terminating proxy in front to
expose it, and set `OPA_PUBLIC_ORIGIN` to the address browsers use (`https://agent.example`) or
setup and login fail with `bad_origin`. Workers AI and background tasks are Cloudflare-only for
now: `/api/health` on Node reports them as `false`, and its status stays `ok`.

On Node, model providers can't reach private, loopback, link-local or cloud-metadata addresses, so
a base URL can't be used to read your network. To use a model server on the same machine or LAN
(Ollama, the mock server), set `OPA_ALLOW_PRIVATE_MODEL_HOSTS=1`. Base URLs may then use `http://`
for any host, but plain HTTP only connects to a private address, so a key never crosses the
internet unencrypted.

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

On a brand-new Cloudflare account, a few one-time steps happen in the dashboard, not in the
script. See [`docs/manual-first-run-checks.md`](docs/manual-first-run-checks.md).

### Deploy button (experimental)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TogetherWeOwn/open-personal-agent)

The button copies this repo into your GitHub account and deploys it with Workers Builds, which
runs `pnpm run deploy` again on every push. It is experimental until the checks in
[`deploy/BUTTON.md`](deploy/BUTTON.md) pass. If you're not asked for the three `OPA_*` secrets,
`/setup` shows the **Finish setup** page with the commands that set them. Workflow names are
unique per account, and the button probably keeps `opa-task-workflow` unprefixed, so plan on one
button deploy per account; to run more than one, use `pnpm deploy:cloudflare --name <prefix>`.

## What this costs

Prices as of 2026-10-31, in USD, excluding tax.

**Required: Cloudflare Workers Paid, $5 per month.** Open Personal Agent runs on your own
Cloudflare account and needs the Workers Paid plan. The $5 is Cloudflare's monthly minimum. It
includes a monthly allowance of requests, Durable Objects, D1 database, R2 storage, Workflows and a
small amount of Workers AI. For one person, and for most households or small teams, normal use of
the app stays inside that allowance. We do not charge anything; this project is free and open
source.

**The $5 does not include unlimited usage.** Cloudflare bills separately for usage above the
included amounts. The ones you are most likely to meet are:

- **AI models.** You bring your own model provider (for example OpenAI, Anthropic, Google,
  OpenRouter or a local model). That provider bills you directly, and this is usually your largest
  cost: from about $0–5 a month for light use on a budget model to $50 or more for heavy use of a
  top model. The built-in Workers AI starter model has a small free daily allowance, then
  Cloudflare bills it per use.
- **Storage above the allowance.** After about 5 GB of database or 10 GB of files.
- **Later features you switch on.** Cloud computers, web search, AI Gateway logging and extra
  browser hours are not in this release. Each will say what it costs before you turn it on.

Budgets, spending warnings and a Usage page are planned but not in this release. Until then, check
your usage in the Cloudflare dashboard under **Billing**.

What each binding in `wrangler.jsonc` uses (CI checks that every binding has a row here):

| Binding         | Cloudflare service      | Included in Workers Paid each month           | Then                                              |
| --------------- | ----------------------- | --------------------------------------------- | ------------------------------------------------- |
| (the Worker)    | Workers                 | 10M requests, 30M CPU-ms                      | $0.30/M requests, $0.02/M CPU-ms                  |
| `ASSETS`        | Static assets (the app) | Unlimited                                     | Free                                              |
| `DB`            | D1                      | 25B rows read, 50M rows written, 5 GB stored  | $0.001/M read, $1.00/M written, $0.75/GB-month    |
| `FILES`         | R2                      | 10 GB-month, 1M Class A and 10M Class B ops   | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B |
| `AI`            | Workers AI              | 10,000 neurons a day                          | $0.011 per 1,000 neurons                          |
| `ASSISTANT`     | Durable Objects         | 1M requests, 400,000 GB-s, 5 GB SQLite stored | $0.15/M requests, $12.50/M GB-s, $0.20/GB-month   |
| `TASK_WORKFLOW` | Workflows               | 500,000 steps, 1 GB-month stored              | $0.80 per 100,000 steps, $0.20/GB-month           |
| `triggers`      | Cron Triggers           | Included                                      | Each run counts as a Worker request and its CPU   |

Prices are Cloudflare's and your providers', and they can change. Check
<https://developers.cloudflare.com/workers/platform/pricing/> for current Cloudflare rates.

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
