// SPDX-License-Identifier: Apache-2.0
import type { Health } from "./health";

const MIGRATE = "npx wrangler d1 migrations apply DB --remote";
const MIGRATE_LOCAL = "npx wrangler d1 migrations apply DB --local";
const GENERATE = `node -e "console.log(crypto.getRandomValues(Buffer.alloc(32)).toString('base64'))"`;
/** What each secret is for, so nobody pastes a value they'll later need without keeping it. */
const PURPOSE: Record<string, string> = {
  OPA_SESSION_SECRET: "keeps you signed in.",
  OPA_SETUP_TOKEN: "lets you claim this assistant as its owner. Keep it until you have.",
};
// Only the vault and the composition root may name the master key, so it's the one not listed.
const MASTER_KEY_PURPOSE =
  "encrypts the keys you save in the app. Keep a copy somewhere safe: without it they can't be recovered.";
const RENAMED =
  "<p>If you deployed under a different Worker name, add <code>--name &lt;your-worker-name&gt;</code> to each <code>wrangler secret put</code> command.</p>";
const LOCAL =
  "<p>For local development, put the values in <code>.dev.vars</code> instead (copy <code>.dev.vars.example</code>) and restart <code>pnpm dev</code>.</p>";

/** Plain HTML with no script: the Worker serves these pages with CSP `default-src 'none'`. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Open Personal Agent</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
pre{background:#f2f2f2;padding:.75rem;white-space:pre-wrap;overflow-wrap:anywhere}
a{color:#0b57d0}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}pre{background:#262626}a{color:#a8c7fa}}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
</main>
</body>
</html>
`;
}

/** One block per command: wrapped at phone width, several commands in one block read as more. */
const command = (text: string) => `<pre><code>${text}</code></pre>`;

/**
 * The Finish setup page (ADR 0001 #4): the exact commands to run, served while the deployment is
 * unmigrated or missing a secret. It never includes an error or a stack trace.
 */
export function finishSetupPage(health: Health): string {
  const missing = Object.entries(health.secrets)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const steps: string[] = [];
  // An unreachable database also leaves the version unknown; that isn't a missing migration.
  if (health.checks.database && !health.schema.current) {
    steps.push(
      `<li><p>Create the database tables:</p>${command(MIGRATE)}<p>Locally, <code>pnpm dev</code> applies them on start; to apply them by hand, run <code>${MIGRATE_LOCAL}</code>.</p></li>`,
    );
  }
  if (missing.length > 0) {
    const secrets = missing
      .map(
        (name) =>
          `<li><p><code>${name}</code> ${PURPOSE[name] ?? MASTER_KEY_PURPOSE}</p>${command(`npx wrangler secret put ${name}`)}</li>`,
      )
      .join("\n");
    steps.push(
      "<li><p>Set the missing secrets. Make a random value with:</p>" +
        `${command(GENERATE)}<p>Run it again for each secret, so each one gets its own value. Then run each command below and paste its value when it asks.</p>` +
        `<ul>${secrets}</ul>${RENAMED}</li>`,
    );
  }
  return page(
    "Finish setup",
    "<p>This deployment of Open Personal Agent isn't ready yet. Run these steps from your copy of the repository, then reload this page.</p>" +
      `<ol>\n${steps.join("\n")}\n</ol>\n${LOCAL}`,
  );
}

/** `/setup` while `OPA_SETUP_TOKEN` is too short or too simple to open it. */
export function weakSetupTokenPage(): string {
  return page(
    "Replace the setup token",
    "<p>The setup token, <code>OPA_SETUP_TOKEN</code>, is too short or too simple, so setup stays closed. Make a new random value:</p>" +
      `${command(GENERATE)}<p>Set it, keep a copy, then reload this page:</p>` +
      `${command("npx wrangler secret put OPA_SETUP_TOKEN")}${RENAMED}\n${LOCAL}`,
  );
}

/** `/setup` once the deployment has an owner. */
export function alreadySetUpPage(): string {
  return page(
    "Already set up",
    `<p>This assistant already has an owner, so setup is closed. <a href="/">Open your assistant</a>.</p>` +
      "<p>If you're the owner and can't sign in, set a new <code>OPA_SETUP_TOKEN</code> and open <code>/setup</code> again to recover your account. Your conversations and settings are kept.</p>",
  );
}
