// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderGuide } from "../generate-verify-guide.mjs";
import { teardownCloudflare } from "../teardown-cloudflare.mjs";
import { newPrefix, verifyCloudflare } from "../verify-cloudflare.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const P = "opa-v-20261101-abc123";

const reply = (status, result) => ({ status, ok: status < 300, json: async () => ({ result }) });

/** A fake account with our prefix, the real `opa` and a look-alike `<prefix>9`. */
function account({ failDelete } = {}) {
  const state = {
    "/workers/scripts": [{ id: P }, { id: "opa" }, { id: `${P}9` }],
    "/workflows": [{ name: `${P}-task-workflow` }, { name: "opa-task-workflow" }],
    "/d1/database": [
      { name: `${P}-db`, uuid: "ours" },
      { name: "opa-db", uuid: "prod" },
    ],
    "/r2/buckets": [{ name: `${P}-files` }, { name: "opa-files" }],
  };
  const [objects, calls, out] = [["a.txt"], [], []];
  const fetch = async (url, init = {}) => {
    const p = new URL(url).pathname.replace("/client/v4/accounts/acc", "");
    calls.push(`${init.method ?? "GET"} ${p}`);
    const base = Object.keys(state).find((k) => p.startsWith(k));
    if (p.includes("/objects")) {
      if (init.method === "DELETE") objects.length = 0;
      const listed = objects.map((key) => ({ key }));
      return reply(200, listed);
    }
    if (!base) return reply(403); // queues: the token has no access
    const list = state[base];
    if (init.method !== "DELETE")
      return reply(200, base === "/r2/buckets" ? { buckets: list } : list);
    if (base === failDelete || (base === "/r2/buckets" && objects.length)) return reply(500);
    const key = p.slice(base.length + 1);
    state[base] = list.filter((r) => ![r.id, r.name, r.uuid].includes(key));
    return reply(200);
  };
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acc" };
  return { deps: { env, fetch, stdout: (t) => out.push(t) }, calls, state, out };
}

const teardown = (t, ...argv) => teardownCloudflare(argv, t.deps);

describe("teardown:cloudflare", () => {
  it("refuses anything but a verification prefix, and a mismatched --confirm", async () => {
    const t = account();
    for (const name of ["opa", "opa-v-1", "opa-v-20261101-ABC123", `${P}4`]) {
      await expect(teardown(t, "--name", name, "--confirm", name)).rejects.toThrow(/refusing/);
    }
    await expect(teardown(t, "--name", P, "--confirm", "opa")).rejects.toThrow(/does not match/);
    expect(t.calls).toEqual([]);
  });

  it("without --confirm only lists what it would delete", async () => {
    const t = account();
    const { left } = await teardown(t, "--name", P);
    expect(left.map((r) => r.name)).toEqual([P, `${P}-task-workflow`, `${P}-db`, `${P}-files`]);
    expect(t.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    expect(t.out.join("")).toContain("queue: not listed");
  });

  it("deletes only the prefix, empties R2 first, and post-checks", async () => {
    const t = account();
    expect((await teardown(t, "--name", P, "--confirm", P)).deleted).toHaveLength(4);
    expect(t.calls.filter((c) => c.startsWith("DELETE"))).toEqual([
      `DELETE /workers/scripts/${P}`,
      `DELETE /workflows/${P}-task-workflow`,
      "DELETE /d1/database/ours",
      `DELETE /r2/buckets/${P}-files/objects/a.txt`,
      `DELETE /r2/buckets/${P}-files`,
    ]);
    expect(t.state["/d1/database"].map((d) => d.name)).toEqual(["opa-db"]);
  });

  it("fails when anything with the prefix is left", async () => {
    const t = account({ failDelete: "/d1/database" });
    await expect(teardown(t, "--name", P, "--confirm", P)).rejects.toThrow(
      `left resources behind:\n  d1: ${P}-db`,
    );
  });
});

const d1 = (uuid) => ({ kind: "d1", name: "d", item: { uuid } });
const ONE_EACH = async () => [d1("u1"), { kind: "r2", name: "b", item: {} }];

/** verify:cloudflare with the deploy, teardown and inventory steps faked. */
function verifySetup({ changes, inventory = ONE_EACH } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "opa-verify-"));
  fs.cpSync(path.join(REPO, "deploy"), path.join(root, "deploy"), { recursive: true });
  fs.mkdirSync(path.join(root, "migrations"));
  fs.writeFileSync(path.join(root, "migrations", "0000_schema_v0.sql"), "");
  const [calls, out] = [[], []];
  const plan = changes ?? [["worker", "migrations", "secrets"], [], ["worker", "migrations"]];
  const url = `https://${P}.owner-sub.workers.dev`;
  const steps = {
    inventory,
    deploy: async (_argv, deps) => {
      calls.push(`deploy ${fs.readdirSync(path.join(root, "migrations")).sort()}`);
      deps.stdout(`Using fallback value in non-interactive context: yes\n${url}\n`);
      return { changed: plan[calls.length - 1], url };
    },
    teardown: async (argv) =>
      calls.push(`teardown ${argv.join(" ")}`) && { deleted: [], skipped: [] },
  };
  const fetch = async () => ({ status: 200, json: async () => ({ status: "ok" }) });
  const deps = { env: {}, root, fetch, stdout: (t) => out.push(t) };
  const report = path.join(root, "report.md");
  const run = () => verifyCloudflare(["--name", P, "--report", report], deps, steps);
  return { root, calls, out, run, report: () => fs.readFileSync(report, "utf8") };
}

describe("verify:cloudflare", () => {
  it("deploys, re-runs, upgrades with a dummy migration, tears down and reports", async () => {
    const t = verifySetup();
    await t.run();
    const [base, mig] = ["0000_schema_v0.sql", "0001_verify_upgrade.sql"];
    expect(t.calls).toEqual([
      `deploy ${base}`,
      `deploy ${base}`,
      `deploy ${base},${mig}`,
      `teardown --name ${P} --confirm ${P}`,
    ]);
    expect(fs.readdirSync(path.join(t.root, "migrations")).sort().join()).toBe(base);
    const report = t.report();
    for (const line of ["Result: **PASS**", "had to answer: 3", `\`${mig}\``, "## Cannot prove"]) {
      expect(report).toContain(line);
    }
    expect(report).toContain("| `workers-ai` | Workers AI Read | not in the token, not needed |");
    expect(report).not.toMatch(/\{\{|owner-sub/);
    expect(t.out.join("")).not.toContain("owner-sub");
  });

  it("fails when the re-run is not up to date, and still tears down", async () => {
    const t = verifySetup({ changes: [["worker", "migrations", "secrets"], ["worker"]] });
    await expect(t.run()).rejects.toThrow("Re-run (up to date): expected [], changed [worker]");
    expect(t.calls.at(-1)).toBe(`teardown --name ${P} --confirm ${P}`);
    expect(t.report()).toContain("Result: **FAIL**");
  });

  it("fails when a re-deploy provisions a second database", async () => {
    let n = 0;
    const t = verifySetup({ inventory: async () => [d1(`u${n++}`)] });
    await expect(t.run()).rejects.toThrow(/did not re-bind/);
    expect(t.calls.at(-1)).toMatch(/^teardown/);
  });

  it("generates prefixes the teardown guard accepts", () => {
    const bytes = () => Buffer.from([0, 9, 10, 35, 36, 71]);
    expect(newPrefix(new Date("2026-11-01T12:00:00Z"), bytes)).toBe("opa-v-20261101-09az0z");
  });
});

it("deploy/VERIFY.md is generated from permissions.json and lists every entry", () => {
  const spec = JSON.parse(fs.readFileSync(path.join(REPO, "deploy/permissions.json"), "utf8"));
  const guide = renderGuide(spec);
  expect(fs.readFileSync(path.join(REPO, "deploy/VERIFY.md"), "utf8")).toBe(guide);
  for (const p of spec.permissions) {
    expect(guide).toContain(p.required ? `| ${p.neededFor} |` : `- ${p.group}:`);
  }
});
