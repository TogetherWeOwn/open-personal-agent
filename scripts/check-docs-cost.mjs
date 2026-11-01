// SPDX-License-Identifier: Apache-2.0
// docs-cost-lint (PRD §17 cost transparency, ADR 0001 #6): the README's "What this costs" states the
// baseline, says the $5 isn't unlimited and dates its prices, and every binding in wrangler.jsonc
// has a cost row there and an entry in deploy/permissions.json.
import { readFileSync } from "node:fs";
import { isMain, parseJsonc, report } from "./lib/repo.mjs";

// Config sections that are not bindings, even where their entries carry a `binding` key.
const NOT_BINDINGS = new Set(["$schema", "exports", "migrations", "vars", "env"]);

/**
 * Binding names in a parsed wrangler config, including those declared only in an `env` section.
 * Cron triggers count as one binding, `triggers`.
 */
export function bindingNames(config) {
  const names = new Set();
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    if (typeof value.binding === "string") names.add(value.binding);
    for (const child of Object.values(value)) walk(child);
  };
  for (const section of [config, ...Object.values(config.env ?? {})]) {
    for (const [key, value] of Object.entries(section)) {
      if (!NOT_BINDINGS.has(key)) walk(value);
    }
    // Durable Object and rate-limit bindings are keyed by `name`, not `binding`.
    for (const { name } of section.durable_objects?.bindings ?? []) names.add(name);
    for (const { name } of section.ratelimits ?? []) names.add(name);
    if (section.triggers?.crons?.length) names.add("triggers");
  }
  return [...names].sort();
}

/** The README's "What this costs" section, up to the next level-2 heading. */
export function costSection(readme) {
  const match = /^## What this costs\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
  return match ? match[1] : null;
}

/** Problems with the README cost section and the binding coverage. */
export function checkDocsCost({ readme, config, permissions }) {
  const section = costSection(readme);
  if (section === null) return ['README.md: no "## What this costs" section'];
  const problems = [];
  if (!/Prices as of \d{4}-\d{2}-\d{2}/.test(section)) {
    problems.push('README.md: "What this costs" has no "Prices as of YYYY-MM-DD" date');
  }
  if (!/Workers Paid, \$5 per month/.test(section)) {
    problems.push('README.md: "What this costs" does not state the Workers Paid $5/month baseline');
  }
  if (!/does not include unlimited usage/.test(section)) {
    problems.push(
      'README.md: "What this costs" does not say the $5 does not include unlimited usage',
    );
  }
  // A cost row is a table row whose first cell is a backticked binding, followed by a filled-in
  // service, included allowance and overage rate. `\|` is a literal pipe inside a cell.
  const costRows = new Set();
  for (const [, first, rest] of section.matchAll(/^\| `([^`]+)` +\|(.*)\|$/gm)) {
    const cells = rest.replace(/\\./g, "_").split("|"); // masks `\|`, but `\\|` still splits
    if (cells.length === 3 && cells.every((cell) => cell.trim())) costRows.add(first);
  }
  const permitted = new Set(permissions.permissions.flatMap((p) => p.bindings ?? []));
  for (const name of bindingNames(config)) {
    if (!costRows.has(name)) {
      problems.push(`${name}: no cost row in the README "What this costs" table`);
    }
    if (!permitted.has(name)) {
      problems.push(`${name}: no entry lists it in deploy/permissions.json "bindings"`);
    }
  }
  return problems;
}

if (isMain(import.meta.url)) {
  const read = (path) => readFileSync(path, "utf8");
  report(
    "docs-cost-lint",
    checkDocsCost({
      readme: read("README.md"),
      config: parseJsonc(read("wrangler.jsonc")),
      permissions: JSON.parse(read("deploy/permissions.json")),
    }),
  );
}
