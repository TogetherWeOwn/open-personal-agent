// SPDX-License-Identifier: Apache-2.0
// The docker-local suite (M4-05): unit coverage that runs everywhere (firewall rule order,
// token-bridge hygiene, tar round-trip, image pins) plus docker-gated coverage that skips
// cleanly without a socket — M4-01 conformance against the real adapter, D5 in-computer
// assertions, SSRF reject assertions (in-computer no-route plus host-side iptables), and
// the PoC-2 genuine task. Firewall enforcement assertions additionally need a programmable
// firewall: direct `iptables`, or `sudo -n iptables` with `OPA_COMPUTER_FIREWALL_SUDO=1`
// (selfhost-parity CI). Without either, only the fail-closed leg runs — create() must
// refuse rather than run a computer unenforced.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { checkComputerProvider, createComputerSpec, type ExecEvent } from "@opa/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TokenBridge } from "../src/docker-local/bridge";
import { DockerEngine, tarSingleFile, untar } from "../src/docker-local/engine";
import {
  applyComputerFirewall,
  buildComputerChainRules,
  type FirewallRunner,
  probeFirewall,
  rejectRuleCidrs,
  removeComputerFirewall,
} from "../src/docker-local/firewall";
import { COMPUTER_BASE_REF, COMPUTER_PINS, computerLocalTag } from "../src/docker-local/image";
import { DockerLocalProvider } from "../src/docker-local/provider";

const execFileAsync = promisify(execFile);

const SOCKET = process.env.OPA_DOCKER_SOCKET ?? "/var/run/docker.sock";
const hasSocket = existsSync(SOCKET);

/** Sync iptables probe for collection-time `skipIf` (only spawned when a socket exists). */
function canProgramDirect(): boolean {
  if (!hasSocket) return false;
  try {
    execFileSync("iptables", ["-L", "DOCKER-USER", "-n"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function canProgramSudo(): boolean {
  if (!hasSocket || process.env.OPA_COMPUTER_FIREWALL_SUDO !== "1") return false;
  try {
    execFileSync("sudo", ["-n", "iptables", "-L", "DOCKER-USER", "-n"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Sync network probe (public clone test only; skipped offline instead of failing). */
function hasPublicGit(): boolean {
  if (!hasSocket) return false;
  try {
    execFileSync("git", ["ls-remote", "https://github.com/sindresorhus/is", "HEAD"], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}

const directFirewall = hasSocket ? canProgramDirect() : false;
const sudoFirewall = !directFirewall && hasSocket ? canProgramSudo() : false;
const firewallUsable = directFirewall || sudoFirewall;
const networkOk = firewallUsable ? hasPublicGit() : false;

/** The runner the docker-gated tests hand the provider (direct, or explicit sudo). */
const sudoRunner: FirewallRunner = (argv) =>
  execFileAsync("sudo", ["-n", "iptables", ...argv]).then(({ stdout, stderr }) => ({
    stdout: stdout.toString(),
    stderr: stderr.toString(),
  }));

const providerFirewallRunner: FirewallRunner | undefined = directFirewall
  ? undefined
  : sudoFirewall
    ? sudoRunner
    : undefined;

function makeProvider(imageRef?: string): DockerLocalProvider {
  return new DockerLocalProvider({
    socketPath: SOCKET,
    imageRef,
    firewallRunner: providerFirewallRunner,
  });
}

describe("computer firewall rules", () => {
  it("rejects RFC 1918, link-local/metadata, loopback and the host entries, v4 only", () => {
    const cidrs = rejectRuleCidrs(["172.28.0.1/32", "10.0.0.0/8"]);
    expect(cidrs).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "172.28.0.1/32",
      ]),
    );
    expect(cidrs.every((cidr) => !cidr.includes(":"))).toBe(true);
  });

  it("orders rejects before allowlist ACCEPTs before the closing REJECT", () => {
    const rules = buildComputerChainRules({
      chain: "opa-test",
      subnet: "172.28.0.0/16",
      allowlist: ["93.184.216.34/32"],
      extraRejects: ["172.28.0.1/32"],
    });
    const texts = rules.map((argv) => argv.join(" "));
    const firstReject = texts.findIndex((rule) => rule.includes("-j REJECT"));
    const accept = texts.findIndex((rule) => rule.includes("-j ACCEPT"));
    expect(firstReject).toBeGreaterThanOrEqual(0);
    expect(accept).toBeGreaterThan(firstReject);
    // The closing REJECT ends the chain body; the DOCKER-USER jump comes last overall.
    expect(texts.at(-2)).toBe("-A opa-test -j REJECT");
    // The DOCKER-USER jump on the computer's subnet is programmed first.
    expect(texts).toContain("-I DOCKER-USER 1 -s 172.28.0.0/16 -j opa-test");
    // The static reject set precedes the host entry, both before the allowlist.
    const metadata = texts.findIndex((rule) => rule.includes("169.254.0.0/16"));
    const hostEntry = texts.findIndex((rule) => rule.includes("172.28.0.1/32"));
    expect(metadata).toBeGreaterThanOrEqual(0);
    expect(hostEntry).toBeGreaterThan(metadata);
    expect(hostEntry).toBeLessThan(accept);
  });

  it("leaves an empty allowlist open-minus-rejects (no closing REJECT)", () => {
    const rules = buildComputerChainRules({
      chain: "opa-test",
      subnet: "172.28.0.0/16",
      allowlist: [],
    }).map((argv) => argv.join(" "));
    expect(rules.some((rule) => rule.includes("-j ACCEPT"))).toBe(false);
    expect(rules[rules.length - 1]).toContain("DOCKER-USER");
  });

  it("programs and removes a chain through the runner, failing closed", async () => {
    const calls: string[][] = [];
    const run: FirewallRunner = async (argv) => {
      calls.push(argv);
      return { stdout: "", stderr: "" };
    };
    await applyComputerFirewall({ chain: "opa-unit", subnet: "172.28.0.0/16", allowlist: [] }, run);
    expect(calls[0]).toEqual(["-N", "opa-unit"]);
    expect(calls).toContainEqual([
      "-I",
      "DOCKER-USER",
      "1",
      "-s",
      "172.28.0.0/16",
      "-j",
      "opa-unit",
    ]);
    calls.length = 0;
    await removeComputerFirewall("opa-unit", "172.28.0.0/16", run);
    expect(calls).toContainEqual(["-D", "DOCKER-USER", "-s", "172.28.0.0/16", "-j", "opa-unit"]);
    expect(calls).toContainEqual(["-X", "opa-unit"]);
    await expect(
      applyComputerFirewall({ chain: "opa-unit", subnet: "172.28.0.0/16", allowlist: [] }, () =>
        Promise.reject(new Error("no iptables")),
      ),
    ).rejects.toThrow(/computer firewall/);
  });

  it("probes unusable with a reason when iptables is missing", async () => {
    const probe = await probeFirewall(() => Promise.reject(new Error("no iptables")));
    expect(probe.usable).toBe(false);
    expect(probe.reason).toMatch(/iptables/);
  });
});

describe("token bridge", () => {
  it("holds exactly one token, revokes on demand, never serializes", () => {
    const bridge = new TokenBridge();
    expect(bridge.attached).toBe(false);
    expect(() => bridge.take()).toThrow(/no token/);
    bridge.attach("tok-123");
    expect(bridge.attached).toBe(true);
    expect(bridge.take()).toBe("tok-123");
    expect(() => bridge.attach("tok-456")).toThrow(/already attached/);
    expect(() => JSON.stringify({ bridge })).toThrow(/never be serialized/);
    bridge.revoke();
    expect(bridge.attached).toBe(false);
    expect(() => bridge.take()).toThrow(/no token/);
    expect(() => bridge.attach("")).toThrow(/non-empty/);
  });
});

describe("engine tar", () => {
  it("round-trips a single file", () => {
    const data = new TextEncoder().encode("hello computers");
    const archive = tarSingleFile("report.txt", data);
    const entries = untar(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("report.txt");
    expect(entries[0]?.data).toEqual(Buffer.from(data));
  });

  it("rejects overlong names instead of truncating them", () => {
    expect(() => tarSingleFile(`${"a".repeat(101)}.txt`, new Uint8Array())).toThrow(/too long/);
  });
});

describe("computer image pins", () => {
  it("references the base by digest and matches the pins", () => {
    expect(COMPUTER_BASE_REF).toMatch(/^node:22-alpine@sha256:[0-9a-f]{64}$/);
    expect(COMPUTER_PINS.git).toMatch(/^\d+\.\d+\.\d+-r\d+$/);
    expect(COMPUTER_PINS.node).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(computerLocalTag()).toMatch(/^opa-computer:[0-9a-f]{12}$/);
  });
});

const dockerSuite = hasSocket ? describe : describe.skip;

dockerSuite("docker-local provider", () => {
  const imageDir = resolve(import.meta.dirname, "../../../computers/image");
  const tag = computerLocalTag();
  let provider: DockerLocalProvider;

  beforeAll(async () => {
    try {
      await execFileAsync("docker", ["image", "inspect", tag]);
    } catch {
      const digest = COMPUTER_BASE_REF.split("@")[1] ?? "";
      await execFileAsync(
        "docker",
        [
          "build",
          "-f",
          resolve(imageDir, "Dockerfile"),
          "--build-arg",
          `BASE_DIGEST=${digest}`,
          "--build-arg",
          `GIT_VERSION=${COMPUTER_PINS.git}`,
          "-t",
          tag,
          imageDir,
        ],
        { timeout: 600_000 },
      );
    }
    provider = makeProvider(tag);
  }, 660_000);

  // Fail-closed leg: without a programmable firewall, create() refuses rather than
  // running a computer unenforced, and the probe names the reason for Settings (M4-10a).
  (firewallUsable ? describe.skip : describe)("without a programmable firewall", () => {
    it("refuses create and reports unavailable", async () => {
      const availability = await provider.probeAvailability();
      expect(availability.available).toBe(false);
      expect(availability.reason).toMatch(/iptables/);
      await expect(provider.create(createComputerSpec({ profile: "standard" }))).rejects.toThrow(
        /firewall/,
      );
    });
  });

  (firewallUsable ? describe : describe.skip)("enforced computers", () => {
    it("probes available", async () => {
      await expect(provider.probeAvailability()).resolves.toEqual({ available: true });
    });

    it("passes the M4-01 conformance suite", async () => {
      await checkComputerProvider(provider);
    }, 300_000);

    it("streams stdin separately from argv and reports exit codes", async () => {
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      try {
        const events: ExecEvent[] = [];
        for await (const event of provider.exec(handle, { argv: ["cat"], stdin: "hello-stdin" })) {
          events.push(event);
        }
        expect(
          events
            .filter((e) => e.type === "stdout")
            .map((e) => (e.type === "stdout" ? e.text : ""))
            .join(""),
        ).toContain("hello-stdin");
        expect(events.at(-1)).toEqual({ type: "exit", code: 0 });

        const envEvents: ExecEvent[] = [];
        for await (const event of provider.exec(handle, {
          argv: ["printenv", "POC2_MARKER"],
          env: { POC2_MARKER: "marker-value" },
        })) {
          envEvents.push(event);
        }
        expect(envEvents.at(-1)).toEqual({ type: "exit", code: 0 });

        const missing: ExecEvent[] = [];
        for await (const event of provider.exec(handle, { argv: ["false"] })) {
          missing.push(event);
        }
        expect(missing.at(-1)).toEqual({ type: "exit", code: 1 });
      } finally {
        await provider.destroy(handle);
      }
    }, 120_000);

    it("aborts on caller cancellation and times out long commands", async () => {
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      try {
        const controller = new AbortController();
        const pending = (async () => {
          const events: ExecEvent[] = [];
          for await (const event of provider.exec(handle, {
            argv: ["sleep", "30"],
            signal: controller.signal,
          })) {
            events.push(event);
          }
          return events;
        })();
        controller.abort();
        const aborted = await pending;
        expect(aborted.at(-1)).toMatchObject({ type: "error", code: "aborted" });

        const timed: ExecEvent[] = [];
        for await (const event of provider.exec(handle, {
          argv: ["sleep", "30"],
          timeoutSeconds: 2,
        })) {
          timed.push(event);
        }
        expect(timed.at(-1)?.type).toBe("error");
      } finally {
        await provider.destroy(handle);
      }
    }, 120_000);

    it("stops a computer and lists it until destroyed", async () => {
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      expect(
        (await provider.list()).some((e) => e.providerComputerId === handle.providerComputerId),
      ).toBe(true);
      await provider.stop(handle);
      const stopped = await provider.list();
      expect(stopped.find((e) => e.providerComputerId === handle.providerComputerId)?.state).toBe(
        "stopped",
      );
      // A stopped computer refuses new exec with `gone`, synchronously.
      expect(() => provider.exec(handle, { argv: ["echo", "hi"] })).toThrow(/not running/);
      await provider.destroy(handle);
      await provider.destroy(handle); // idempotent
    }, 120_000);

    it("reaps an orphan unknown to this process (post-restart destroy by label)", async () => {
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      expect(
        (await provider.list()).some((e) => e.providerComputerId === handle.providerComputerId),
      ).toBe(true);
      // A fresh instance has no in-memory state — the host-restart case — yet destroy()
      // must still remove the container, firewall chain and network by label.
      const restarted = makeProvider(tag);
      await restarted.destroy(handle);
      expect(
        (await restarted.list()).some((e) => e.providerComputerId === handle.providerComputerId),
      ).toBe(false);
      await restarted.destroy(handle); // idempotent
    }, 120_000);

    it("runs D5-hardened by construction (non-root, dropped caps, no mounts)", async () => {
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      const run = async (argv: string[]): Promise<{ out: string; exit: number }> => {
        let out = "";
        let exit = -1;
        for await (const event of provider.exec(handle, { argv })) {
          if (event.type === "stdout" || event.type === "stderr") out += event.text;
          else if (event.type === "exit") exit = event.code;
          else exit = 99;
        }
        return { out, exit };
      };
      try {
        await expect(run(["id", "-u"])).resolves.toMatchObject({ out: "10000\n", exit: 0 });
        await expect(run(["whoami"])).resolves.toMatchObject({ out: "computer\n", exit: 0 });
        const status = await run(["cat", "/proc/self/status"]);
        expect(status.exit).toBe(0);
        expect(status.out).toMatch(/CapEff:\s+0+\b/);
        expect(status.out).toMatch(/Seccomp:\s+2\b/);
        // No Docker socket, no host mounts: the unit's storage is its own tmpfs only.
        await expect(run(["ls", "/var/run/docker.sock"])).resolves.toMatchObject({ exit: 1 });
        const mounts = await run(["cat", "/proc/self/mountinfo"]);
        expect(mounts.exit).toBe(0);
        // No socket, no host data mounts: the only container bind-mounts Docker itself
        // adds are the standard hostname/hosts/resolv.conf files.
        expect(mounts.out).not.toMatch(/docker\.sock/i);
        for (const line of mounts.out.split("\n")) {
          if (line.includes("/docker/containers")) {
            expect(line).toMatch(/hostname|hosts|resolv\.conf/);
          }
        }
      } finally {
        await provider.destroy(handle);
      }
    }, 120_000);

    it("rejects the SSRF set in-computer, before any allowlist", async () => {
      // The allowlist names a rejected IP: reject still wins (AC3 ordering, behavioral).
      const handle = await provider.create(
        createComputerSpec({ profile: "standard", egressHosts: ["169.254.169.254"] }),
      );
      const fetchScript = (target: string) =>
        `fetch(${JSON.stringify(target)}, { signal: AbortSignal.timeout(8000) })` +
        `.then((r) => { console.log("REACHED " + r.status); process.exit(1); })` +
        `.catch(() => process.exit(0));`;
      const run = async (target: string): Promise<number> => {
        for await (const event of provider.exec(handle, {
          argv: ["node", "-e", fetchScript(target)],
        })) {
          if (event.type === "exit") return event.code;
          if (event.type === "error") return 99;
        }
        return 99;
      };
      try {
        await expect(run("http://169.254.169.254/")).resolves.toBe(0);
        await expect(run("http://10.255.255.1/")).resolves.toBe(0);
        await expect(run("http://192.168.0.1/")).resolves.toBe(0);
        // The computer's own gateway, read from its route table, is unreachable too.
        let gateway = "";
        for await (const event of provider.exec(handle, {
          argv: [
            "node",
            "-e",
            `const fs = require("fs");` +
              `for (const line of fs.readFileSync("/proc/net/route", "utf8").split("\\n").slice(1)) {` +
              `const f = line.trim().split(/\\s+/);` +
              `if (f[1] === "00000000" && f[2]) {` +
              `const n = parseInt(f[2], 16);` +
              `console.log([(n & 255), ((n >> 8) & 255), ((n >> 16) & 255), ((n >> 24) & 255)].join(".")); break; } }`,
          ],
        })) {
          if (event.type === "stdout") gateway += event.text;
        }
        gateway = gateway.trim();
        expect(gateway.length).toBeGreaterThan(0);
        await expect(run(`http://${gateway}/`)).resolves.toBe(0);
      } finally {
        await provider.destroy(handle);
      }
    }, 180_000);

    it("programs host-side REJECTs with the DOCKER-USER jump first", async () => {
      const engine = new DockerEngine({ socketPath: SOCKET });
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      const check = async (argv: string[]): Promise<boolean> => {
        try {
          if (providerFirewallRunner) await providerFirewallRunner(argv);
          else await execFileAsync("iptables", argv);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const networks = (await engine.call("GET", "/networks", undefined)) as {
          Name: string;
          IPAM?: { Config?: { Subnet?: string }[] };
        }[];
        const network = networks.find((n) => n.Name === `opa-${handle.providerComputerId}`);
        const subnet = network?.IPAM?.Config?.[0]?.Subnet;
        expect(subnet).toBeTruthy();
        // The jump from DOCKER-USER on the computer's subnet exists…
        const chains = await (async () => {
          try {
            if (providerFirewallRunner) {
              return (await providerFirewallRunner(["-S", "DOCKER-USER"])).stdout;
            }
            return (await execFileAsync("iptables", ["-S", "DOCKER-USER"])).stdout.toString();
          } catch {
            return "";
          }
        })();
        const jump = chains.split("\n").find((line) => line.includes(`-s ${subnet}`));
        expect(jump).toBeTruthy();
        const chain = jump?.split(" -j ").at(-1)?.trim() ?? "";
        expect(chain.length).toBeGreaterThan(0);
        // …and the chain rejects the metadata address and RFC 1918 before anything else.
        await expect(
          check(["-C", chain, "-d", "169.254.169.254/16", "-j", "REJECT"]),
        ).resolves.toBe(true);
        await expect(check(["-C", chain, "-d", "10.0.0.0/8", "-j", "REJECT"])).resolves.toBe(true);
      } finally {
        await provider.destroy(handle);
      }
    }, 120_000);

    it("leaks no token into the image, container config or logs", async () => {
      const engine = new DockerEngine({ socketPath: SOCKET });
      const image = (await engine.call("GET", `/images/${encodeURIComponent(tag)}/json`)) as {
        Config?: { Env?: string[] | null };
      };
      // The base image sets its own PATH/NODE_VERSION; what must never appear is a secret.
      for (const entry of image.Config?.Env ?? []) {
        expect(entry).not.toMatch(/token|secret|password|credential/i);
      }
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      try {
        const containers = (await engine.call("GET", "/containers/json?all=1", undefined)) as {
          Id: string;
          Labels?: Record<string, string>;
        }[];
        const ours = containers.find(
          (c) => c.Labels?.["opa.computer"] === handle.providerComputerId,
        );
        expect(ours).toBeTruthy();
        const detail = (await engine.call("GET", `/containers/${ours?.Id}/json`)) as {
          Config?: { Env?: string[] | null; Cmd?: string[] | null };
          Mounts?: unknown[];
        };
        // The container adds nothing to the image's env — and no secrets anywhere.
        expect(detail.Config?.Env ?? []).toEqual(image.Config?.Env ?? []);
        for (const entry of detail.Config?.Env ?? []) {
          expect(entry).not.toMatch(/token|secret|password|credential/i);
        }
        expect(detail.Config?.Cmd).toEqual(["sleep", "infinity"]);
        expect(detail.Mounts ?? []).toEqual([]);
      } finally {
        await provider.destroy(handle);
      }
    }, 120_000);

    it("runs the PoC-2 genuine task: files in, tests run, report exported", async () => {
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      try {
        await provider.putFile(
          handle,
          "/work/task/package.json",
          new TextEncoder().encode(
            JSON.stringify({
              name: "poc2-task",
              version: "0.0.1",
              scripts: { test: "node --test test.js" },
            }),
          ),
        );
        await provider.putFile(
          handle,
          "/work/task/test.js",
          new TextEncoder().encode(
            `const { test } = require("node:test");\n` +
              `const assert = require("node:assert/strict");\n` +
              `test("adds", () => assert.equal(1 + 1, 2));\n` +
              `test("multiplies", () => assert.equal(3 * 4, 12));\n`,
          ),
        );
        const npmInstall: ExecEvent[] = [];
        for await (const event of provider.exec(handle, {
          argv: ["npm", "install", "--no-audit", "--no-fund"],
          cwd: "/work/task",
          timeoutSeconds: 180,
        })) {
          npmInstall.push(event);
        }
        expect(npmInstall.at(-1)).toEqual({ type: "exit", code: 0 });

        let testOut = "";
        const npmTest: ExecEvent[] = [];
        for await (const event of provider.exec(handle, {
          argv: ["npm", "test"],
          cwd: "/work/task",
          timeoutSeconds: 180,
        })) {
          if (event.type === "stdout" || event.type === "stderr") testOut += event.text;
          npmTest.push(event);
        }
        expect(npmTest.at(-1)).toEqual({ type: "exit", code: 0 });
        expect(testOut).toMatch(/# pass 2/);

        await provider.putFile(
          handle,
          "/work/report.json",
          new TextEncoder().encode(JSON.stringify({ task: "poc2", passed: 2, failed: 0 })),
        );
        const artifact = await provider.exportArtifact(handle, "/work/report.json");
        expect(artifact.name).toBe("report.json");
        expect(JSON.parse(new TextDecoder().decode(artifact.data))).toEqual({
          task: "poc2",
          passed: 2,
          failed: 0,
        });
        const roundTripped = await provider.getFile(handle, "/work/report.json");
        expect(roundTripped).toEqual(artifact.data);
      } finally {
        await provider.destroy(handle);
      }
    }, 300_000);

    (networkOk ? it : it.skip)(
      "clones a public repo over the filtered egress",
      async () => {
        const handle = await provider.create(createComputerSpec({ profile: "standard" }));
        try {
          const events: ExecEvent[] = [];
          for await (const event of provider.exec(handle, {
            argv: [
              "git",
              "clone",
              "--depth",
              "1",
              "https://github.com/sindresorhus/is",
              "/work/is",
            ],
            cwd: "/work",
            timeoutSeconds: 120,
          })) {
            events.push(event);
          }
          expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
          const ls: ExecEvent[] = [];
          for await (const event of provider.exec(handle, {
            argv: ["ls", "/work/is/package.json"],
          })) {
            ls.push(event);
          }
          expect(ls.at(-1)).toEqual({ type: "exit", code: 0 });
        } finally {
          await provider.destroy(handle);
        }
      },
      180_000,
    );
  });
});

afterAll(async () => {
  // Best-effort: a failed test must not strand billing computers or firewall chains.
  if (!hasSocket) return;
  const engine = new DockerEngine({ socketPath: SOCKET });
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: ["opa.provider=docker-local"] }));
    const listed = (await engine.call("GET", `/containers/json?all=1&filters=${filters}`)) as {
      Id: string;
    }[];
    for (const container of listed) {
      try {
        await engine.call("DELETE", `/containers/${container.Id}?force=true`);
      } catch {
        /* already gone */
      }
    }
    const networks = (await engine.call("GET", "/networks", undefined)) as {
      Id: string;
      Labels?: Record<string, string>;
    }[];
    for (const network of networks) {
      if (network.Labels?.["opa.provider"] === "docker-local") {
        try {
          await engine.call("DELETE", `/networks/${network.Id}`);
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* daemon unreachable: nothing to clean */
  }
});
