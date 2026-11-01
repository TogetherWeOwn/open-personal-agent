// SPDX-License-Identifier: Apache-2.0
import type { Health } from "./health";

const MIGRATE = "npx wrangler d1 migrations apply DB --remote";

/**
 * The Finish setup page (ADR 0001 #4): plain HTML with the exact commands to run, served while
 * the deployment is unmigrated or missing a secret. It never includes an error or a stack trace.
 */
export function finishSetupPage(health: Health): string {
  const missing = Object.entries(health.secrets)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const steps: string[] = [];
  // An unreachable database also leaves the version unknown; that isn't a missing migration.
  if (health.checks.database && !health.schema.current) {
    steps.push(`<li><p>Create the database tables:</p><pre><code>${MIGRATE}</code></pre></li>`);
  }
  if (missing.length > 0) {
    const names = missing.map((name) => `<code>${name}</code>`).join(", ");
    const puts = missing.map((name) => `npx wrangler secret put ${name}`).join("\n");
    steps.push(
      `<li><p>Set the missing secrets: ${names}. Run each command below and paste 32 random ` +
        "bytes, base64-encoded, when it asks:</p>" +
        `<pre><code>${puts}</code></pre></li>`,
    );
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finish setup · Open Personal Agent</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
pre{background:#f2f2f2;padding:.75rem;overflow-x:auto;white-space:pre-wrap}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}pre{background:#262626}}
</style>
</head>
<body>
<main>
<h1>Finish setup</h1>
<p>This deployment of Open Personal Agent isn't ready yet. Run these steps from your copy of the repository, then reload this page.</p>
<ol>
${steps.join("\n")}
</ol>
<p>If you deployed under a different Worker name, add <code>--name &lt;your-worker-name&gt;</code> to each <code>wrangler secret put</code> command. For local development, copy <code>.dev.vars.example</code> to <code>.dev.vars</code>, fill in each value and restart <code>pnpm dev</code>.</p>
</main>
</body>
</html>
`;
}
