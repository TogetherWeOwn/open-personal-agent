<!-- Generated from deploy/permissions.json by `pnpm docs:verify`. Do not edit. -->
# Verifying a deploy on a real account

## 1. Mint the token

Cloudflare dashboard: **My Profile → API Tokens → Create Token → Create Custom Token**. Name it
`opa-verify-<date>`, include only the account you verify on, no zones, and let it expire
tomorrow. Add exactly these permissions:

| Scope | Permission | Access | Needed for |
|---|---|---|---|
| Account | Workers Scripts | Edit | uploading the Worker with its Durable Object, Workflow, cron and assets; setting secrets; the workers.dev URL |
| Account | D1 | Edit | creating the DB database and applying migrations |
| Account | Workers R2 Storage | Edit | creating the FILES bucket |
| Account | Account Settings | Read | looking up the account |

Leave these out:

- Workers AI Read: verified 2026-11-01 (M2-05 run): not needed; the deploy passed without it
- User Details Read, Memberships Read: verified 2026-11-01 (M2-05 run): not needed, because the script passes CLOUDFLARE_ACCOUNT_ID to wrangler
- Queues Edit: only when a queue binding is added
- Containers Edit: only when configuration B (M4)

## 2. Run the verification

Under a throwaway prefix `opa-v-<yyyymmdd>-<rand>` it deploys, claims the deployment in a browser with a
virtual passkey, onboards with the starter model on Workers AI and waits for a first answer
(within the free daily allowance), re-runs (must be up to date), upgrades with a dummy migration,
checks health, tears everything down and writes a report.

- **GitHub:** put the token and the account ID in the `cf-verify` environment as
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, run **deploy-verify** on `main` and
  approve the deployment. The report is the `verify-report` artifact.
- **Your machine:** export both variables (`read -rs CLOUDFLARE_API_TOKEN` keeps the token out
  of your shell history), then run `pnpm verify:cloudflare`.

## 3. Clean up

If teardown did not finish, `pnpm teardown:cloudflare --name opa-v-<yyyymmdd>-<rand>` lists what is left and
adding `--confirm opa-v-<yyyymmdd>-<rand>` deletes it; in GitHub, run **deploy-verify** with
`teardown_prefix`. Then delete the token in Cloudflare and the secrets in `cf-verify`.
