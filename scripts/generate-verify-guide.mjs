#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Writes deploy/VERIFY.md, the token-minting guide and verification runbook, from
// deploy/permissions.json (ADR 0001 #6). `--check` fails if the file is out of date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function renderGuide(spec) {
  // "Workers R2 Storage Edit" is "Workers R2 Storage" with access "Edit" in the dashboard.
  const rows = spec.permissions
    .filter((p) => p.required)
    .map((p) => {
      const [, group, access] = p.group.match(/^(.*) (Read|Edit)$/) ?? [null, p.group, ""];
      return `| ${p.scope === "user" ? "User" : "Account"} | ${group} | ${access} | ${p.neededFor} |`;
    });
  const leaveOut = [
    ...spec.permissions.filter((p) => !p.required).map((p) => `- ${p.group}: ${p.status}`),
    ...spec.notInM2.map((p) => `- ${p.group}: only when ${p.when}`),
  ];
  const prefix = "opa-v-<yyyymmdd>-<rand>";
  return `<!-- Generated from deploy/permissions.json by \`pnpm docs:verify\`. Do not edit. -->
# Verifying a deploy on a real account

## 1. Mint the token

Cloudflare dashboard: **My Profile → API Tokens → Create Token → Create Custom Token**. Name it
\`opa-verify-<date>\`, include only the account you verify on, no zones, and let it expire
tomorrow. Add exactly these permissions:

| Scope | Permission | Access | Needed for |
|---|---|---|---|
${rows.join("\n")}

Leave these out:

${leaveOut.join("\n")}

## 2. Run the verification

Under a throwaway prefix \`${prefix}\` it deploys, claims the deployment in a browser with a
virtual passkey, onboards with the starter model on Workers AI and waits for a first answer
(within the free daily allowance), re-runs (must be up to date), upgrades with a dummy migration,
checks health, tears everything down and writes a report.

- **GitHub:** put the token and the account ID in the \`cf-verify\` environment as
  \`CLOUDFLARE_API_TOKEN\` and \`CLOUDFLARE_ACCOUNT_ID\`, run **deploy-verify** on \`main\` and
  approve the deployment. The report is the \`verify-report\` artifact.
- **Your machine:** export both variables (\`read -rs CLOUDFLARE_API_TOKEN\` keeps the token out
  of your shell history), then run \`pnpm verify:cloudflare\`.

## 3. Clean up

If teardown did not finish, \`pnpm teardown:cloudflare --name ${prefix}\` lists what is left and
adding \`--confirm ${prefix}\` deletes it; in GitHub, run **deploy-verify** with
\`teardown_prefix\`. Then delete the token in Cloudflare and the secrets in \`cf-verify\`.
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "deploy", "permissions.json"), "utf8"));
  const file = path.join(ROOT, "deploy", "VERIFY.md");
  const text = renderGuide(spec);
  if (!process.argv.includes("--check")) fs.writeFileSync(file, text);
  else if (fs.readFileSync(file, "utf8") !== text) {
    process.stderr.write("deploy/VERIFY.md is out of date: run `pnpm docs:verify`\n");
    process.exit(1);
  }
}
