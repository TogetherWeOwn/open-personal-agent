# Deploy-button check (manual)

The Deploy button runs in the Cloudflare dashboard, so a person runs this check by hand. It
answers three open questions about the button (ADR 0001):

1. Does it ask for the secrets in `.dev.vars.example`?
2. Do the Durable Object, the Workflow and the cron trigger register?
3. Does a second push, deployed by Workers Builds, keep the same D1 database and R2 bucket?

Use a throwaway prefix `opa-v-<yyyymmdd>-<rand>` (six lowercase letters or digits) for every name,
so `pnpm teardown:cloudflare` can find what is left. Before you start, check that no Workflow named
`opa-task-workflow` exists on the account (**Workers & Pages → Workflows**). The button uses
`wrangler.jsonc` as it is, so the Workflow keeps that name and takes no prefix.

## 1. Deploy

1. Open the button link in the README while signed in to the account you are checking.
2. Connect GitHub and name the new repo `<prefix>` (private is fine).
3. Name the Worker `<prefix>`, the D1 database `<prefix>-db` and the R2 bucket `<prefix>-files`.
4. Note whether `OPA_MASTER_KEY`, `OPA_SESSION_SECRET` and `OPA_SETUP_TOKEN` are asked for, and
   whether the `cloudflare.bindings` descriptions from `package.json` show up. If they are asked
   for, fill each with `openssl rand -base64 32`.
5. Leave the build and deploy commands as filled in (`pnpm run build` and `pnpm run deploy`), and
   deploy. Save the build log.

## 2. Check what registered

- **Worker → Settings → Bindings:** `DB`, `FILES`, `AI`, `ASSISTANT` (Durable Object) and
  `TASK_WORKFLOW` (Workflow).
- **Worker → Settings → Trigger events:** the cron `*/10 * * * *`.
- **Workers & Pages → Workflows:** `opa-task-workflow`.
- **Worker → Settings → Variables and secrets:** the three `OPA_*` secrets, if they were asked for.
- `https://<prefix>.<subdomain>.workers.dev/api/health`: the schema version and each binding.
  Without the secrets it answers `setup_required`, and `/setup` shows **Finish setup**.

## 3. Push again

1. In the new repo, push a commit that changes only a comment (for example in `README.md`).
2. Wait for the Workers Builds deploy and save its log.
3. Check that **Worker → Settings → Bindings** shows the same D1 database and R2 bucket (same IDs)
   as in step 2, that no second `<prefix>-db…` database or bucket appeared, and that
   `/api/health` reports the same schema version.

## 4. Tear down

1. **Worker → Settings → Build:** disconnect the repo, then delete the Worker.
2. Delete the D1 database, the R2 bucket (empty it first) and the `opa-task-workflow` Workflow,
   or run **deploy-verify** with `teardown_prefix: <prefix>`, which also lists anything left. The
   Workflow still has to go by hand, because it has no prefix.
3. Delete the `<prefix>` repo in GitHub. If the Cloudflare GitHub app was installed only for this
   check, remove it under **GitHub → Settings → Applications**.

## Report

| Question | Answer | Evidence |
|---|---|---|
| Secrets asked for? | yes / no | screenshot of the form |
| Binding descriptions shown? | yes / no | screenshot |
| DO, Workflow and cron registered? | yes / no for each | Bindings and Trigger events pages |
| Second push keeps D1 and R2? | yes / no | IDs before and after, build log |
| Teardown complete? | yes / no | empty `teardown:cloudflare` list; repo deleted |

If the secrets are not asked for, the README keeps the button marked experimental.
