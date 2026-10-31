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

`pnpm dev` builds the web app and runs the Worker locally with `wrangler dev`. It serves the app
and `GET /api/health` without a Cloudflare account. It serves the web app as built, so for live
reload of web changes run `pnpm dev:web` alongside it (Vite on port 5173, proxying `/api`).

| Command                           | What it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `pnpm test`                       | Vitest: unit tests in Node and Worker tests in the Workers runtime        |
| `pnpm lint`                       | Biome lint and format check                                               |
| `pnpm typecheck`                  | `tsc --noEmit` in every package                                           |
| `pnpm deploy:dry-run`             | Builds and bundles the Worker without deploying it                        |
| `pnpm --filter @opa/web test:e2e` | Playwright: axe, keyboard send and screenshot baselines (`visual` CI job) |

## Layout

- `wrangler.jsonc`: the single Worker and its bindings (D1, R2, Workers AI, the `Assistant` Durable
  Object, `TaskWorkflow`, a cron trigger and the static assets). Resource IDs are omitted, so
  wrangler provisions them on the first deploy.
- `apps/worker`: the Worker entry point (Hono API, Durable Object, Workflow, cron handler).
- `apps/web`: the single-page web app, served as static assets.
- `packages/*`: shared, runtime-agnostic packages.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
