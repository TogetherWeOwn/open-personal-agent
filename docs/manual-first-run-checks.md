# Manual first-run checks

`pnpm deploy:cloudflare` does everything it can through the Cloudflare API and wrangler. A few
account-level steps happen once per Cloudflare account, in the dashboard, and only a person can do
them. They come up on a brand-new account. On an account that has already used these services they
are already done, which is also why our own deploy tests can't prove them: those tests run on an
account where every step below is done.

Do these once, before your first deploy. Each takes a minute or two.

| #   | Check                                                                                                               | Where                                                      | What the deploy does if it's missing                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | **Activate Workers Paid** ($5/month; see [What this costs](../README.md#what-this-costs))                           | Dashboard → **Workers & Pages** → **Plans**                | Cloudflare refuses the deploy. The script stops with "Workers Paid ($5/month) is required" and the plans link |
| 2   | **Register a `workers.dev` subdomain.** It becomes part of your app's URL, `https://<name>.<subdomain>.workers.dev` | Dashboard → **Workers & Pages** (first visit asks for one) | Preflight stops with "no workers.dev subdomain" and the link                                                  |
| 3   | **Enable R2** and accept its billing terms                                                                          | Dashboard → **R2 Object Storage** → **Overview**           | Preflight stops with "R2 is not enabled" and the link                                                         |
| 4   | **Open D1 once** if the dashboard shows a first-use prompt                                                          | Dashboard → **Storage & Databases** → **D1**               | Not detected. If it is needed, creating the `DB` database fails during the deploy step                        |
| 5   | **Any other first-run prompt** the dashboard shows for Workers, Durable Objects, Workflows or Workers AI            | Dashboard                                                  | Not detected. The deploy step fails with wrangler's error. Accept the prompt and re-run                       |

Queues are not used yet, so there is nothing to enable for them. When a release adds a queue, this
list will gain a row.

## After the checks

Run `pnpm deploy:cloudflare`. A re-run is safe: it picks up where the last run stopped, or prints
"Up to date".

If a step fails with "missing permission", the API token is missing an entry from
[`deploy/permissions.json`](../deploy/permissions.json). That is a token problem, not a first-run
check.

## Help us keep this list right

If your first deploy hit a prompt or error that isn't listed here, please open an issue with the
message you saw. No automated test can start from a fresh account, so reports from real first
deploys are how this list stays complete.
