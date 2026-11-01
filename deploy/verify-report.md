# Fresh-deploy verification: `{{prefix}}`

- Result: {{result}} ({{date}}, commit `{{commit}}`)
- Prompts a person would have had to answer: {{prompts}}

## Timings ({{total}} s in all)

| Phase | Time | Result |
|---|---|---|
{{phases}}

## Permission diff (token minted from `deploy/permissions.json`)

| Entry | Permission | Outcome |
|---|---|---|
{{permissions}}

## Re-binding on re-deploy (no resource IDs in the config)

Upgrade migration: `{{migration}}`.

| Snapshot | D1 databases | R2 buckets |
|---|---|---|
{{rebinding}}

## Teardown

{{teardown}} Delete the API token now, in Cloudflare and in the `cf-verify` environment.

## Cannot prove on an existing account (check by hand on a new one)

- registering a `workers.dev` subdomain;
- enabling R2, D1 and Queues for the first time, and accepting the R2 billing terms;
- activating Workers Paid, and the error a Free account gets;
- any other first-run prompt in the Cloudflare dashboard.
