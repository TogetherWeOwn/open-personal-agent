// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deployCloudflare } from "../deploy-cloudflare.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const TOKEN = "cf-token-canary-7f3a";
const ACCOUNT = "acc123";
const ALL_SECRETS = ["OPA_MASTER_KEY", "OPA_SESSION_SECRET", "OPA_SETUP_TOKEN"];

/** A temp repo root plus fakes for wrangler, the Cloudflare API and the terminal. */
function setup({ deployedTag = null, existingSecrets = [], forbidden = [], ...opts } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "opa-deploy-"));
  fs.cpSync(path.join(REPO, "wrangler.jsonc"), path.join(root, "wrangler.jsonc"));
  fs.cpSync(path.join(REPO, "deploy"), path.join(root, "deploy"), { recursive: true });
  const [calls, out, terminal, canaries] = [[], [], [], []];
  const deps = {
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, PATH: process.env.PATH },
    root,
    nodeVersion: "22.12.0",
    randomBytes: (n) => {
      const value = Buffer.alloc(n, 0xa0 + canaries.length);
      canaries.push(value.toString("base64"));
      return value;
    },
    sleep: async () => {},
    stdout: (text) => out.push(text),
    tty: () => (text) => terminal.push(text),
    run: async (cmd, args, { env, input, onOutput }) => {
      const sub = cmd === "pnpm" ? args : args.slice(1);
      calls.push({ argv: [cmd, ...args], env, input, sub: sub.join(" ") });
      const result = await fakeWrangler(sub);
      // Wrangler warnings go to stderr, and output can split a value across chunks.
      onOutput?.(`token ${TOKEN.slice(0, 6)}`);
      onOutput?.(`${TOKEN.slice(6)}\n`);
      return { ...result, stdout: result.output, output: `▲ [WARNING] x\n${result.output}` };
    },
    fetch: async (url) => {
      const p = new URL(url).pathname.replace("/client/v4", "");
      const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
      const ok = (result) => reply(200, { success: true, result });
      if (url.endsWith("/api/health")) return reply(opts.health ?? 200, {});
      if (forbidden.some((f) => p.includes(f))) return reply(403, { success: false, errors: [] });
      if (p === "/user/tokens/verify") return ok({ status: "active" });
      if (p.endsWith("/workers/subdomain")) return ok({ subdomain: "me" });
      if (p.endsWith("/deployments")) {
        if (!deployedTag) return reply(404, { success: false });
        const deployment = (id) => ({ versions: [{ version_id: id, percentage: 100 }] });
        return ok({ deployments: (opts.history ?? ["v3", "v1"]).map(deployment) });
      }
      if (p.endsWith("/versions")) {
        const later = { "workers/triggered_by": opts.laterTrigger ?? "secret" };
        return ok({
          items: [
            { id: "v3", number: 3, annotations: later },
            { id: "v2", number: 2, annotations: { "workers/triggered_by": "upload" } }, // a draft
            { id: "v1", number: 1, annotations: { "workers/tag": deployedTag } },
          ],
        });
      }
      return ok([]);
    },
  };
  async function fakeWrangler(sub) {
    if (sub[0] === "auth")
      return { code: 0, output: JSON.stringify({ type: "api_token", token: TOKEN }) };
    if (sub[0] === "deploy" && sub[1] === "--dry-run") {
      fs.mkdirSync(sub[3], { recursive: true });
      fs.writeFileSync(path.join(sub[3], "index.js"), "export default {}");
    }
    if (sub[0] === "deploy" && sub[1] !== "--dry-run" && forbidden.includes("deploy")) {
      return { code: 1, output: "Authentication error [code: 10000] (403)" };
    }
    if (sub[0] === "d1") return { code: 0, output: "✅ No migrations to apply!" };
    if (sub[0] === "secret" && sub[1] === "list") {
      return { code: 0, output: JSON.stringify(existingSecrets.map((name) => ({ name }))) };
    }
    return { code: 0, output: "" };
  }
  /** Fails if a canary secret or the token shows up in stdout, an argv, a child env or a file. */
  const expectNoLeaks = (calls) => {
    const files = fs.readdirSync(root, { recursive: true }).map((f) => path.join(root, f));
    const text = files
      .filter((f) => fs.statSync(f).isFile())
      .map((f) => fs.readFileSync(f, "utf8"));
    const channels = [out.join(""), JSON.stringify(calls), text.join("\n")];
    for (const secret of [...canaries, TOKEN]) {
      for (const channel of channels) expect(channel).not.toContain(secret);
    }
  };
  return { deps, calls, out, terminal, canaries, expectNoLeaks };
}

describe("deploy:cloudflare", () => {
  it("dry run with canary secrets leaks nothing to stdout, argv, env or files", async () => {
    const t = setup();
    const result = await deployCloudflare(["--dry-run", "--name", "opa-v-20261031-abc123"], t.deps);
    expect(result.dryRun).toBe(true);
    expect(t.canaries).toHaveLength(3);
    t.expectNoLeaks(t.calls);
    expect(t.terminal).toEqual([]);
    const subs = t.calls.map((c) => c.sub);
    expect(subs.filter((s) => /^deploy(?! --dry-run)|^secret|^d1/.test(s))).toEqual([]);
  });

  it("deploys, pipes secrets on stdin only, and shows the setup link on the terminal", async () => {
    const t = setup();
    const result = await deployCloudflare(["--name", "opa-v-20261031-abc123"], t.deps);
    expect(result.changed).toEqual(["worker", "secrets"]);
    const bulk = t.calls.find((c) => c.sub.startsWith("secret bulk"));
    expect(Object.keys(JSON.parse(bulk.input))).toEqual(ALL_SECRETS);
    t.expectNoLeaks([...t.calls.filter((c) => c !== bulk), bulk.argv, bulk.env]);
    expect(t.terminal.join("")).toContain(
      `https://opa-v-20261031-abc123.me.workers.dev/setup#token=${t.canaries[2]}`,
    );
  });

  it("re-run with nothing changed is a no-op that reports up to date", async () => {
    const first = setup();
    const { tag } = await deployCloudflare(["--dry-run"], first.deps);
    const t = setup({ deployedTag: tag, existingSecrets: ALL_SECRETS });
    const result = await deployCloudflare([], t.deps);
    expect(result.changed).toEqual([]);
    expect(t.out.join("")).toContain("Up to date: nothing changed.");
    const subs = t.calls.map((c) => c.sub);
    expect(subs.some((s) => /^deploy -c/.test(s) || s.startsWith("secret bulk"))).toBe(false);
    expect(t.canaries).toEqual([]);
  });

  it("never regenerates an existing OPA_MASTER_KEY", async () => {
    const t = setup({ existingSecrets: ["OPA_MASTER_KEY"] });
    await deployCloudflare([], t.deps);
    const bulk = t.calls.find((c) => c.sub.startsWith("secret bulk"));
    expect(Object.keys(JSON.parse(bulk.input))).toEqual(["OPA_SESSION_SECRET", "OPA_SETUP_TOKEN"]);
  });

  it("names a missing permission with its permissions.json entry", async () => {
    await expect(deployCloudflare([], setup({ forbidden: ["/r2/buckets"] }).deps)).rejects.toThrow(
      /missing permission "Workers R2 Storage Edit" \(account\).*entry "r2"/,
    );
    const t = setup({ forbidden: ["deploy"] });
    await expect(deployCloudflare([], t.deps)).rejects.toThrow(/entry "workers-scripts"/);
  });

  it("prefixes the Workflow name and rejects unsafe names", async () => {
    const t = setup();
    await deployCloudflare(["--dry-run", "--name", "opa-v-1"], t.deps);
    const file = path.join(t.deps.root, ".wrangler/opa-deploy/opa-v-1/wrangler.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).workflows[0].name).toBe(
      "opa-v-1-task-workflow",
    );
    await expect(deployCloudflare(["--name", "Bad_Name"], t.deps)).rejects.toThrow(/invalid name/);
  });

  it("redeploys on drift, or when the history page does not reach the tagged version", async () => {
    const { tag } = await deployCloudflare(["--dry-run"], setup().deps);
    const t = setup({ deployedTag: tag, existingSecrets: ALL_SECRETS, laterTrigger: "upload" });
    expect((await deployCloudflare([], t.deps)).changed).toEqual(["worker"]);
    const short = setup({ deployedTag: tag, existingSecrets: ALL_SECRETS, history: ["v3"] });
    expect((await deployCloudflare([], short.deps)).changed).toEqual(["worker"]);
  });

  it("shows the setup link before waiting for health", async () => {
    const t = setup({ health: 503 });
    await expect(deployCloudflare([], t.deps)).rejects.toThrow(/did not answer 200/);
    expect(t.terminal.join("")).toContain(`/setup#token=${t.canaries[2]}`);
  });
});
