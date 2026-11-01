// SPDX-License-Identifier: Apache-2.0
// Checks the `pnpm deploy:dry-run` output: no server-only env names in the client bundle (R7 M2-4;
// gitleaks scans for secret values), and the Worker and web app stay within gzipped budgets.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { isMain, readText, report } from "./lib/repo.mjs";

const KiB = 1024;
/** Gzipped budgets. Cloudflare's own Worker limit is 3 MiB (Free) or 10 MiB (Paid). */
export const BUDGETS = { worker: 1024 * KiB, web: 300 * KiB };
export const SERVER_ONLY = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/** Secret names declared in .dev.vars.example, plus the deploy credentials. */
export function serverOnlyNames(devVarsExample) {
  const declared = [...devVarsExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  return [...declared, ...SERVER_ONLY];
}

export function findLeakedNames(files, names) {
  return files.flatMap(({ path, text }) =>
    names.filter((n) => text.includes(n)).map((n) => `${path}: contains server-only "${n}"`),
  );
}

export function checkBudget(label, gzippedBytes, budget) {
  const kib = (n) => `${(n / KiB).toFixed(1)} KiB`;
  console.log(`${label}: ${kib(gzippedBytes)} gzipped (budget ${kib(budget)})`);
  return gzippedBytes > budget ? [`${label} is over its budget`] : [];
}

const walk = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

const gzipped = (paths) => paths.reduce((sum, p) => sum + gzipSync(readFileSync(p)).length, 0);

if (isMain(import.meta.url)) {
  const web = walk("apps/web/dist");
  const webText = web.map((path) => ({ path, text: readText(path) ?? "" }));
  const worker = walk("dist/worker").filter((p) => !p.endsWith(".map"));
  report("bundles", [
    ...findLeakedNames(webText, serverOnlyNames(readText(".dev.vars.example") ?? "")),
    ...checkBudget("worker bundle", gzipped(worker), BUDGETS.worker),
    ...checkBudget("web bundle", gzipped(web.filter((p) => !p.endsWith(".map"))), BUDGETS.web),
  ]);
}
