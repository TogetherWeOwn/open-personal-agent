// SPDX-License-Identifier: Apache-2.0
// The docker-local computer provider (M4-05 AC1–AC2, Configuration C): genuine Docker
// containers behind the M4-01 `ComputerProvider` port. One computer is one container on its
// own bridge network, hardened by construction (D5: no binds, no socket mount, non-root uid
// 10000, default seccomp, pids/memory/cpu caps) with the host-side SSRF firewall
// (`firewall.ts`) applied before any user allowlist. The capability token lives only in the
// per-computer `TokenBridge` (`bridge.ts`) and is revoked on stop/destroy; images are
// digest-pinned (`image.ts`), exec argv is never a shell, and exec stdin rides separately
// for the M4-00a/M4-04 token delivery to come.
import { lookup } from "node:dns/promises";
import {
  assertComputerSpec,
  type ComputerCapabilities,
  type ComputerHandle,
  type ComputerProfile,
  type ComputerProvider,
  ComputerProviderError,
  type ComputerSpec,
  type ComputerState,
  type ExecEvent,
  type ExecRequest,
} from "@opa/core";
import { TokenBridge } from "./bridge";
import { DockerEngine, engineErrorStatus, tarSingleFile, untar } from "./engine";
import {
  applyComputerFirewall,
  type FirewallRunner,
  probeFirewall,
  removeComputerFirewall,
} from "./firewall";
import { COMPUTER_BASE_REF, computerLocalTag } from "./image";

export const DOCKER_LOCAL_PROVIDER_ID = "docker-local" as const;

/** Which profile the local Docker host offers: only `standard` (no disks, no browser). */
const PROFILES: ComputerProfile[] = ["standard"];

/** Container resource caps (D5, by construction). */
const CONTAINER_LIMITS = {
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
} as const;

const COMPUTER_USER = "10000";
const KEEPALIVE_ARGV = ["sleep", "infinity"];

export interface DockerLocalProviderOptions {
  /** Docker socket; defaults to the standard path. */
  socketPath?: string | undefined;
  /**
   * Image create() boots: a digest ref (`name@sha256:…`) or a local build tag. Resolved to
   * the immutable image Id before first create — a tag-only reference never reaches the
   * daemon. Defaults to the shared computer build tag (`image.ts`).
   */
  imageRef?: string | undefined;
  /** Host gateway/LAN CIDRs appended to the static reject set (AC3). */
  hostRejects?: readonly string[] | undefined;
  /**
   * Overrides how `iptables` runs (tests only): e.g. a `sudo -n iptables` prefix where the
   * runner lacks NET_ADMIN but may sudo. Production never sets this — direct programming
   * that fails refuses the computer fail-closed instead.
   */
  firewallRunner?: FirewallRunner | undefined;
}

interface LiveComputer {
  containerId: string;
  networkId: string;
  chain: string;
  subnet: string;
  createdAt: number;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  profile: ComputerProfile;
  state: ComputerState;
  bridge: TokenBridge;
}

const randomId = (): string =>
  `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const toHandle = (provider: string, id: string, live: LiveComputer): ComputerHandle => ({
  providerId: provider,
  providerComputerId: id,
  profile: live.profile,
  state: live.state,
  createdAt: new Date(live.createdAt).toISOString(),
  idleDeadlineAt: new Date(live.createdAt + live.idleTimeoutSeconds * 1000).toISOString(),
  lifetimeDeadlineAt: new Date(live.createdAt + live.maxLifetimeSeconds * 1000).toISOString(),
});

const providerError = (
  message: string,
  code: ComputerProviderError["code"],
): ComputerProviderError => new ComputerProviderError(`docker-local: ${message}`, code);

async function resolveAllowlist(egressHosts: readonly string[] | undefined): Promise<string[]> {
  if (!egressHosts || egressHosts.length === 0) return [];
  const cidrs: string[] = [];
  for (const host of egressHosts) {
    const trimmed = host.trim();
    if (trimmed.length === 0) {
      throw providerError("egressHosts must be non-empty strings", "invalid_spec");
    }
    // A literal resolves to itself; a name resolves via DNS to every current address.
    // DNS answers are checked per address at the firewall (destination-IP filtering), so
    // a rebinding answer still has to land inside this resolved set to pass.
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(trimmed, { all: true });
    } catch {
      throw providerError(`egress host "${trimmed}" does not resolve`, "invalid_spec");
    }
    if (addresses.length === 0) {
      throw providerError(`egress host "${trimmed}" does not resolve`, "invalid_spec");
    }
    for (const { address, family } of addresses) {
      if (family === 4) cidrs.push(`${address}/32`);
      else if (family === 6) cidrs.push(`${address}/128`);
    }
  }
  return cidrs;
}

export interface DockerLocalAvailability {
  available: boolean;
  /** Why not — surfaced greyed-out by Settings (M4-10a) on hosts without Docker. */
  reason?: string | undefined;
}

export class DockerLocalProvider implements ComputerProvider {
  readonly id = DOCKER_LOCAL_PROVIDER_ID;
  private readonly engine: DockerEngine;
  private readonly imageRef: string;
  private readonly hostRejects: readonly string[];
  private readonly firewallRunner: FirewallRunner | undefined;
  private imageId: string | null = null;
  private readonly live = new Map<string, LiveComputer>();

  constructor(options: DockerLocalProviderOptions = {}) {
    this.engine = new DockerEngine({ socketPath: options.socketPath ?? "/var/run/docker.sock" });
    this.imageRef = options.imageRef ?? computerLocalTag();
    this.hostRejects = options.hostRejects ?? [];
    this.firewallRunner = options.firewallRunner;
  }

  /**
   * Whether this host can run docker-local computers: socket + daemon + programmable
   * firewall. The Node root registers the provider only when this says yes; everywhere
   * else (Worker, socketless hosts) Settings shows it greyed out with `reason` (M4-10a).
   */
  async probeAvailability(): Promise<DockerLocalAvailability> {
    try {
      await this.engine.call("GET", "/version");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `docker daemon is not reachable: ${detail}` };
    }
    const firewall = await probeFirewall(this.firewallRunner);
    if (!firewall.usable) return { available: false, reason: firewall.reason };
    return { available: true };
  }

  capabilities(): ComputerCapabilities {
    return {
      credentialDelivery: "proxy-token",
      egressControl: "allowlist",
      profiles: [...PROFILES],
      persistentDisk: false,
      surfaces: {
        execStream: true,
        files: true,
        browser: false,
        desktop: false,
        snapshot: false,
        preview: false,
      },
    };
  }

  /** Resolves the configured ref to its immutable image Id (once, then cached). */
  private async resolvedImage(): Promise<string> {
    if (this.imageId) return this.imageId;
    let inspected: { Id?: unknown };
    try {
      inspected = await this.engine.call(
        "GET",
        `/images/${encodeURIComponent(this.imageRef)}/json`,
      );
    } catch (error) {
      if (engineErrorStatus(error) === 404) {
        throw providerError(
          `image "${this.imageRef}" is not present: build it from computers/image first`,
          "provider",
        );
      }
      throw providerError(
        `image inspect failed: ${error instanceof Error ? error.message : String(error)}`,
        "provider",
      );
    }
    if (typeof inspected.Id !== "string" || inspected.Id.length === 0) {
      throw providerError(`image "${this.imageRef}" has no Id`, "provider");
    }
    this.imageId = inspected.Id;
    return this.imageId;
  }

  async create(spec: ComputerSpec): Promise<ComputerHandle> {
    assertComputerSpec(spec);
    if (!PROFILES.includes(spec.profile)) {
      throw providerError(
        `profile "${spec.profile}" is not offered (only standard)`,
        "invalid_spec",
      );
    }
    const firewall = await probeFirewall(this.firewallRunner);
    if (!firewall.usable) {
      throw providerError(
        `host firewall is not programmable (${firewall.reason}): refusing to run unenforced`,
        "provider",
      );
    }
    const imageId = await this.resolvedImage();
    const allowlist = await resolveAllowlist(spec.egressHosts);

    const id = randomId();
    const chain = `opa-${id.replace(/[^a-z0-9]/g, "").slice(0, 12)}`;
    let networkId = "";
    let containerId = "";
    let subnet = "";
    try {
      const network = await this.engine.call<{ Id: string }>("POST", "/networks/create", {
        Name: `opa-${id}`,
        Driver: "bridge",
        Internal: false,
        EnableIPv6: false,
        Labels: { "opa.provider": this.id, "opa.computer": id },
      });
      if (typeof network?.Id !== "string" || network.Id.length === 0) {
        throw providerError("network create returned no Id", "provider");
      }
      networkId = network.Id;
      const inspected = await this.engine.call<{
        IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
      }>("GET", `/networks/${networkId}`);
      subnet = inspected.IPAM?.Config?.[0]?.Subnet ?? "";
      const gateway = inspected.IPAM?.Config?.[0]?.Gateway ?? "";
      if (!subnet) throw providerError("network inspect returned no subnet", "provider");

      // The reject set, host-side (AC3): statics + configured host entries + this
      // computer's own gateway and subnet, before any allowlist ACCEPT.
      const extraRejects = [
        ...this.hostRejects,
        ...(gateway ? [`${gateway}/32`] : []),
        `${subnet}`,
      ];
      const created = await this.engine.call<{ Id: string }>("POST", "/containers/create", {
        Image: imageId,
        Cmd: KEEPALIVE_ARGV,
        User: COMPUTER_USER,
        WorkingDir: "/work",
        NetworkDisabled: false,
        HostConfig: {
          NetworkMode: networkId,
          CapDrop: ["ALL"],
          PidsLimit: CONTAINER_LIMITS.pidsLimit,
          Memory: CONTAINER_LIMITS.memoryBytes,
          NanoCpus: CONTAINER_LIMITS.nanoCpus,
          Binds: [],
        },
        NetworkingConfig: { EndpointsConfig: { [networkId]: {} } },
        Labels: { "opa.provider": this.id, "opa.computer": id },
      });
      if (typeof created?.Id !== "string" || created.Id.length === 0) {
        throw providerError("container create returned no Id", "provider");
      }
      containerId = created.Id;

      await applyComputerFirewall({ chain, subnet, allowlist, extraRejects }, this.firewallRunner);

      try {
        await this.engine.call("POST", `/containers/${containerId}/start`);
      } catch (error) {
        throw providerError(
          `container start failed: ${error instanceof Error ? error.message : String(error)}`,
          "provider",
        );
      }

      const now = Date.now();
      const live: LiveComputer = {
        containerId,
        networkId,
        chain,
        subnet,
        createdAt: now,
        idleTimeoutSeconds: spec.idleTimeoutSeconds,
        maxLifetimeSeconds: spec.maxLifetimeSeconds,
        profile: spec.profile,
        state: "running",
        bridge: new TokenBridge(),
      };
      this.live.set(id, live);
      return toHandle(this.id, id, live);
    } catch (error) {
      // Fail-closed create: a half-built computer (container without firewall, or vice
      // versa) is torn down before the error escapes, never handed out unenforced.
      if (containerId) {
        try {
          await this.engine.call("DELETE", `/containers/${containerId}?force=true`);
        } catch {
          /* best-effort */
        }
      }
      if (networkId) {
        await removeComputerFirewall(
          chain,
          subnet,
          this.firewallRunner ?? (async () => ({ stdout: "", stderr: "" })),
        ).catch(() => {});
        try {
          await this.engine.call("DELETE", `/networks/${networkId}`);
        } catch {
          /* best-effort */
        }
      }
      if (error instanceof ComputerProviderError) throw error;
      throw providerError(error instanceof Error ? error.message : String(error), "provider");
    }
  }

  /**
   * Validates synchronously (unknown computer, bad argv) before returning the stream; post-
   * start failures arrive as terminal `{type: "error"}` events, never a second throw.
   */
  exec(handle: ComputerHandle, request: ExecRequest): AsyncIterable<ExecEvent> {
    const live = this.live.get(handle.providerComputerId);
    if (live?.state !== "running") {
      throw providerError(`computer "${handle.providerComputerId}" is not running`, "gone");
    }
    if (!Array.isArray(request.argv) || request.argv.length === 0) {
      throw providerError("argv must be a non-empty array (never a shell string)", "invalid_spec");
    }
    if (request.argv.some((arg) => typeof arg !== "string")) {
      throw providerError("argv entries must be strings", "invalid_spec");
    }
    const env = request.env
      ? Object.entries(request.env).map(([key, value]) => `${key}=${value}`)
      : [];
    return this.runExec(live, handle.providerComputerId, request, env);
  }

  private async *runExec(
    live: LiveComputer,
    providerComputerId: string,
    request: ExecRequest,
    env: string[],
  ): AsyncGenerator<ExecEvent> {
    let execId: string;
    try {
      const created = await this.engine.call<{ Id: string }>(
        "POST",
        `/containers/${live.containerId}/exec`,
        {
          AttachStdin: request.stdin !== undefined,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Cmd: request.argv,
          Env: env,
          User: COMPUTER_USER,
          WorkingDir: request.cwd ?? "/work",
        },
        request.signal,
      );
      if (typeof created?.Id !== "string") throw new Error("exec create returned no Id");
      execId = created.Id;
    } catch (error) {
      if (error instanceof ComputerProviderError) {
        yield { type: "error", code: error.code, message: error.message };
        return;
      }
      yield {
        type: "error",
        code: request.signal?.aborted ? "aborted" : "provider",
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    void providerComputerId;
    const events: ExecEvent[] = [];
    try {
      await this.engine.startExec(
        execId,
        (stream, text) => {
          if (text.length > 0) events.push({ type: stream, text });
        },
        {
          stdin: request.stdin,
          signal: request.signal,
          timeoutMs: (request.timeoutSeconds ?? 120) * 1000,
        },
      );
    } catch (error) {
      const aborted =
        request.signal?.aborted || (error instanceof Error && /abort/i.test(error.message));
      yield {
        type: "error",
        code: aborted ? "aborted" : "provider",
        message: error instanceof Error ? error.message : String(error),
      };
      return;
    }
    for (const event of events) yield event;
    try {
      const inspected = await this.engine.call<{ ExitCode?: unknown }>(
        "GET",
        `/exec/${execId}/json`,
      );
      const code = typeof inspected.ExitCode === "number" ? inspected.ExitCode : 1;
      yield { type: "exit", code };
    } catch (error) {
      yield {
        type: "error",
        code: "provider",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Runs a quiet setup command (mkdir before an archive PUT), discarding output. */
  private async runQuiet(containerId: string, argv: string[]): Promise<void> {
    const created = await this.engine.call<{ Id: string }>(
      "POST",
      `/containers/${containerId}/exec`,
      {
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        Cmd: argv,
        User: COMPUTER_USER,
        WorkingDir: "/work",
      },
    );
    if (typeof created?.Id !== "string") throw new Error("exec create returned no Id");
    await this.engine.startExec(created.Id, () => {}, { timeoutMs: 15_000 });
  }

  private requireLive(handle: ComputerHandle): LiveComputer {
    const live = this.live.get(handle.providerComputerId);
    if (!live || live.state === "destroyed") {
      throw providerError(`computer "${handle.providerComputerId}" is gone`, "gone");
    }
    return live;
  }

  async putFile(handle: ComputerHandle, path: string, data: Uint8Array): Promise<void> {
    const live = this.requireLive(handle);
    if (!path.startsWith("/")) throw providerError("path must be absolute", "invalid_spec");
    const slash = path.lastIndexOf("/");
    const dir = slash <= 0 ? "/" : path.slice(0, slash);
    const base = path.slice(slash + 1);
    if (!base || base === "." || base === "..") {
      throw providerError("path must name a file", "invalid_spec");
    }
    try {
      await this.runQuiet(live.containerId, ["mkdir", "-p", dir]);
      const archive = tarSingleFile(base, data);
      await this.engine.raw(
        "PUT",
        `/containers/${live.containerId}/archive?path=${encodeURIComponent(dir)}`,
        archive,
        "application/x-tar",
      );
    } catch (error) {
      if (error instanceof ComputerProviderError) throw error;
      throw providerError(error instanceof Error ? error.message : String(error), "provider");
    }
  }

  async getFile(handle: ComputerHandle, path: string): Promise<Uint8Array> {
    const live = this.requireLive(handle);
    if (!path.startsWith("/")) throw providerError("path must be absolute", "invalid_spec");
    let archive: Buffer;
    try {
      archive = await this.engine.raw(
        "GET",
        `/containers/${live.containerId}/archive?path=${encodeURIComponent(path)}`,
        null,
        null,
      );
    } catch (error) {
      if (engineErrorStatus(error) === 404) {
        throw providerError(`file "${path}" not found`, "not_found");
      }
      throw providerError(error instanceof Error ? error.message : String(error), "provider");
    }
    const entries = untar(archive);
    const base = path.slice(path.lastIndexOf("/") + 1);
    const match =
      entries.find((entry) => entry.name === base) ??
      entries.find((entry) => entry.name.endsWith(`/${base}`)) ??
      entries[0];
    if (!match) throw providerError(`file "${path}" not found`, "not_found");
    return match.data;
  }

  async exportArtifact(
    handle: ComputerHandle,
    path: string,
  ): Promise<{ name: string; data: Uint8Array }> {
    const data = await this.getFile(handle, path);
    const name = path.slice(path.lastIndexOf("/") + 1) || "artifact";
    return { name, data };
  }

  async stop(handle: ComputerHandle): Promise<void> {
    const live = this.live.get(handle.providerComputerId);
    if (!live || live.state === "destroyed") return;
    // The token dies with the running computer, before anything else stops.
    live.bridge.revoke();
    try {
      await this.engine.call("POST", `/containers/${live.containerId}/stop?t=10`);
    } catch (error) {
      if (engineErrorStatus(error) === 404) {
        live.state = "stopped";
        return;
      }
      throw providerError(error instanceof Error ? error.message : String(error), "provider");
    }
    live.state = "stopped";
  }

  async destroy(handle: ComputerHandle): Promise<void> {
    const live = this.live.get(handle.providerComputerId);
    if (!live) return; // idempotent: never seen, nothing to do
    if (live.state !== "destroyed") {
      live.bridge.revoke();
      try {
        await this.engine.call("DELETE", `/containers/${live.containerId}?force=true`);
      } catch (error) {
        if (engineErrorStatus(error) !== 404) {
          throw providerError(error instanceof Error ? error.message : String(error), "provider");
        }
      }
      await removeComputerFirewall(live.chain, live.subnet, this.firewallRunner);
      try {
        await this.engine.call("DELETE", `/networks/${live.networkId}`);
      } catch {
        // Best-effort: the container is gone, so a lingering empty network bills nothing
        // and the sweep's next listing still reconciles it.
      }
      live.state = "destroyed";
    }
  }

  async list(): Promise<ComputerHandle[]> {
    let listed: { Id: string; Labels?: Record<string, string>; State?: string; Created?: number }[];
    try {
      const filters = encodeURIComponent(JSON.stringify({ label: [`opa.provider=${this.id}`] }));
      listed = await this.engine.call("GET", `/containers/json?all=1&filters=${filters}`);
    } catch (error) {
      throw providerError(error instanceof Error ? error.message : String(error), "provider");
    }
    const known = new Map([...this.live.values()].map((live) => [live.containerId, live] as const));
    const now = Date.now();
    return listed.map((entry) => {
      const live = known.get(entry.Id);
      if (live) {
        const id = [...this.live.entries()].find(([, v]) => v === live)?.[0] ?? entry.Id;
        return toHandle(this.id, id, live);
      }
      // A container this process did not create (restarted host): report from daemon
      // state with default deadlines so the sweep can still reconcile it.
      const createdAt = (entry.Created ?? Math.floor(now / 1000)) * 1000;
      const computerId = entry.Labels?.["opa.computer"] ?? entry.Id.slice(0, 12);
      const state: ComputerState = entry.State === "running" ? "running" : "stopped";
      return {
        providerId: this.id,
        providerComputerId: computerId,
        profile: "standard" as ComputerProfile,
        state,
        createdAt: new Date(createdAt).toISOString(),
        idleDeadlineAt: new Date(createdAt + 300 * 1000).toISOString(),
        lifetimeDeadlineAt: new Date(createdAt + 3600 * 1000).toISOString(),
      };
    });
  }
}

/** The default image ref when none is configured: the digest-pinned base (`image.ts`). */
export const DOCKER_LOCAL_DEFAULT_IMAGE = COMPUTER_BASE_REF;
