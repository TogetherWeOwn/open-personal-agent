// SPDX-License-Identifier: Apache-2.0
// The ssh-vm computer provider (M4-06): the `ComputerProvider` port over SSH to a user-supplied
// VM. One provider instance is bound to one `SshVmProviderEntry` (one VM); each `create()` boots
// the shared digest-pinned image in a Docker container with a named /work volume. A host-only
// `.computer.json` record rediscovers computers after a control-plane restart; that directory,
// the Docker socket and the SSH credential are never mounted into the computer.
//
// Security shape (AC1): the SSH key is a vault secret (`ssh_private_key` purpose) whose AAD
// binding is `sshCredentialBinding(entry)`. The control plane loads it per connection through
// `loadSshPrivateKey` and passes it only to the ssh2 auth packet — never into the computer (no
// env var, file, command line, URL or log), never to disk, and never through the M4-02 lifecycle
// record. Host keys are pinned: the adapter connects only to a server presenting a pinned
// `SHA256:` key, never trust-on-first-use. Connections are per operation; nothing is pooled.
// `argv` is POSIX single-quoted at the transport boundary, so argument elements can never break
// out into extra shell commands. Env vars travel as `export` builtins, and `stdin` rides the
// channel — neither is ever a shell string.
//
// What this provider does NOT do (AC2, honest capabilities): no egress enforcement (`none` —
// `authenticated_browser`/`subscription_cli` profiles and non-empty `egressHosts` are refused as
// `unsupported` rather than silently ignored), no snapshot/preview surfaces, and `stop()` never
// touches the VM itself — it stops only that computer's container. `persistentDisk: true`
// means its named /work volume survives container stops and control-plane restarts; destroy
// removes the container, volume and host-only metadata.
//
// `exec()` can only throw synchronously for what it can check without I/O (undeclared surface,
// malformed argv): lifecycle state lives on the VM across the network, so unknown/stopped
// computers surface as terminal `{type: "error"}` events carrying the same `not_found`/`gone`
// codes the port uses for throws — the event contract already anticipates exactly these codes.
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  assertComputerSpec,
  assertSshVmEntry,
  type ComputerCapabilities,
  type ComputerHandle,
  type ComputerProvider,
  ComputerProviderError,
  type ExecEvent,
  type ExecRequest,
  SSH_VM_DEFAULT_PORT,
  SSH_VM_PROFILES,
  SSH_VM_PROVIDER_ID,
  type SshVmProviderEntry,
  sshCredentialBinding,
  sshVmCapabilities,
} from "@opa/core";
import { decrypt, type UserScope, type Vault } from "@opa/vault";
import { type Channel, Client, type SFTPWrapper } from "ssh2";
import {
  assertSshImageRef,
  SSH_COMPUTER_IMAGE_TAG,
  SSH_COMPUTER_UID,
  type SshVmProviderOptions,
} from "./ssh-image";

/** Loads the entry's OpenSSH private key. The composition root binds vault, scope and entry. */
export type SshPrivateKeyLoader = () => Promise<string>;

const METADATA_NAME = ".computer.json";
const READY_TIMEOUT_MS = 30_000;
const CREATE_ATTEMPTS = 3;
const GUEST_TOOLS = ["docker", "sh", "rm"] as const;
const OPERATION_TIMEOUT_SECONDS = 60;
const commandFor = (argv: readonly string[]): string => argv.map(quoteForSh).join(" ");
const containerName = (id: string): string => `opa-ssh-${id}`;
const volumeName = (id: string): string => `opa-ssh-${id}-work`;

/** A separate session lets cancellation kill this exec's descendants, not the computer. */
function computerCommand(id: string, request: ExecRequest, executionId: string): string {
  const path = `/tmp/.opa-exec-${executionId}`;
  const script = [
    `printf '%s\\n' "$$" > ${quoteForSh(`${path}.pid`)} || exit 125`,
    `if test -e ${quoteForSh(`${path}.cancel`)}; then rm -f -- ${quoteForSh(`${path}.pid`)} ${quoteForSh(`${path}.cancel`)}; exit 125; fi`,
    `(${remoteCommand("/work", request)})`,
    "status=$?",
    `rm -f -- ${quoteForSh(`${path}.pid`)} ${quoteForSh(`${path}.cancel`)}`,
    'exit "$status"',
  ].join("; ");
  return commandFor(["docker", "exec", "-i", containerName(id), "setsid", "sh", "-c", script]);
}

async function cancelComputerExec(conn: Client, id: string, executionId: string): Promise<void> {
  const path = `/tmp/.opa-exec-${executionId}`;
  // Publish cancellation first: even an exec not yet dispatched must not start guest code.
  const script = [
    `: > ${quoteForSh(`${path}.cancel`)} || exit 125`,
    `if test -f ${quoteForSh(`${path}.pid`)}; then`,
    `read -r pid < ${quoteForSh(`${path}.pid`)}`,
    'case "$pid" in ""|*[!0-9]*) exit 125 ;; esac',
    'kill -KILL -- -"$pid" 2>/dev/null || true',
    `rm -f -- ${quoteForSh(`${path}.pid`)}`,
    "fi",
  ].join("\n");
  await checkedRemote(conn, ["docker", "exec", containerName(id), "sh", "-c", script]);
}

async function captureRemote(
  conn: Client,
  command: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  let stdout = "";
  let stderr = "";
  for await (const event of runRemote(conn, command, {
    stdin,
    timeoutSeconds: OPERATION_TIMEOUT_SECONDS,
  })) {
    if (event.type === "stdout") stdout += event.text;
    else if (event.type === "stderr") stderr += event.text;
    else if (event.type === "error") throw providerError(event.message, event.code);
    else return { stdout, stderr, code: event.code };
  }
  throw providerError("remote operation ended without a status", "provider");
}

async function checkedRemote(conn: Client, argv: readonly string[]): Promise<string> {
  const result = await captureRemote(conn, commandFor(argv));
  if (result.code !== 0) {
    throw providerError(
      `remote ${argv[0]} failed (exit ${result.code}): ${result.stderr.slice(-4096)}`,
      "provider",
    );
  }
  return result.stdout.trim();
}

function providerError(
  message: string,
  code: ComputerProviderError["code"],
): ComputerProviderError {
  return new ComputerProviderError(`ssh-vm provider: ${message}`, code);
}

function unsupported(surface: string): ComputerProviderError {
  return new ComputerProviderError(
    `provider "${SSH_VM_PROVIDER_ID}" does not offer the ${surface} surface`,
    "unsupported",
  );
}

/**
 * POSIX single-quotes one argv element (exported for tests): `a'b` becomes `'a'\''b'`, so a
 * hostile element can never terminate the quoting and inject a second command.
 */
export function quoteForSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The whole remote command as one shell string: `cd` guards, `export` builtins, then `exec`. */
export function remoteCommand(workspaceDir: string, request: ExecRequest): string {
  const parts = [`cd ${quoteForSh(workspaceDir)} || exit 127`];
  if (request.cwd !== undefined) {
    const dir = request.cwd.startsWith("/") ? request.cwd : `${workspaceDir}/${request.cwd}`;
    parts.push(`cd ${quoteForSh(dir)} || exit 127`);
  }
  const assignments = Object.entries(request.env ?? {}).map(
    ([name, value]) => `${name}=${quoteForSh(value)}`,
  );
  if (assignments.length > 0) parts.push(`export ${assignments.join(" ")}`);
  parts.push(`exec ${request.argv.map(quoteForSh).join(" ")}`);
  return parts.join("; ");
}

/** Sync-checkable request shape: argv presence, env names, cwd and timeout types. */
function assertValidRequest(request: ExecRequest): void {
  if (!Array.isArray(request.argv) || request.argv.length === 0) {
    throw providerError("exec argv must be a non-empty array", "invalid_spec");
  }
  for (const name of Object.keys(request.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw providerError(`exec env name "${name}" is not a shell identifier`, "invalid_spec");
    }
  }
  if (request.cwd !== undefined && (typeof request.cwd !== "string" || request.cwd.length === 0)) {
    throw providerError("exec cwd must be a non-empty string when present", "invalid_spec");
  }
  if (request.timeoutSeconds !== undefined) {
    if (
      typeof request.timeoutSeconds !== "number" ||
      !Number.isFinite(request.timeoutSeconds) ||
      request.timeoutSeconds <= 0
    ) {
      throw providerError(
        "exec timeoutSeconds must be a positive number when present",
        "invalid_spec",
      );
    }
  }
}

/**
 * Loads the entry's SSH credential from the vault (M4-06 AC1). Purpose `ssh_private_key` plus the
 * entry binding in the AAD mean a key saved for one entry never decrypts for another entry or
 * purpose, even with the same secret id.
 */
export async function loadSshPrivateKey(
  vault: Vault,
  scope: UserScope,
  entry: SshVmProviderEntry,
): Promise<string> {
  return decrypt(vault, scope, {
    secretId: entry.credentialSecretId,
    purpose: "ssh_private_key",
    binding: sshCredentialBinding(entry),
    caller: "computers-ssh",
  });
}

/** SHA256 pin of a raw host key, in the OpenSSH `SHA256:` fingerprint form pins use. */
function hostKeyPin(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64")}`;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Open one authenticated, pin-checked connection. The caller owns closing it. */
function openConnection(entry: SshVmProviderEntry, privateKey: string): Promise<Client> {
  const port = entry.port ?? SSH_VM_DEFAULT_PORT;
  const target = `${entry.username}@${entry.host}:${port}`;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const fail = (message: string): void => {
      conn.destroy();
      reject(providerError(message, "provider"));
    };
    const onError = (error: Error): void => {
      // Host-key mismatches and auth failures both arrive here; neither carries key material
      // and neither message does either, so both are safe to relay verbatim.
      fail(`cannot connect to ${target}: ${errorDetail(error)}`);
    };
    conn.once("ready", () => {
      conn.removeListener("error", onError);
      resolve(conn);
    });
    conn.once("error", onError);
    conn.once("close", () => {
      fail(`connection to ${target} closed before ready`);
    });
    try {
      conn.connect({
        host: entry.host,
        port,
        username: entry.username,
        privateKey,
        readyTimeout: READY_TIMEOUT_MS,
        hostVerifier: (key: Buffer) => entry.hostKeyPins.some((pin) => pin === hostKeyPin(key)),
      });
    } catch (error) {
      fail(`cannot connect to ${target}: ${errorDetail(error)}`);
    }
  });
}

/** Runs one operation over a fresh connection, closing it however the operation settles. */
async function withConnection<T>(
  entry: SshVmProviderEntry,
  loadPrivateKey: SshPrivateKeyLoader,
  fn: (conn: Client) => Promise<T>,
): Promise<T> {
  const conn = await openConnection(entry, await loadPrivateKey().catch(wrapKeyError));
  try {
    return await fn(conn);
  } finally {
    conn.destroy();
  }
}

async function wrapKeyError(error: unknown): Promise<string> {
  throw providerError(`cannot load SSH credential: ${errorDetail(error)}`, "provider");
}

function sftpOf(conn: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    conn.sftp((error, sftp) => {
      if (error) reject(providerError(`sftp subsystem failed: ${errorDetail(error)}`, "provider"));
      else resolve(sftp);
    });
  });
}

/** An SFTP failure is "no such file" by numeric status, with message fallbacks for servers. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 2 || code === "ENOENT") return true;
  return /no such file/i.test(errorDetail(error));
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, Buffer.from(data), (error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, stats) => {
      if (error) reject(error);
      else resolve(stats);
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<{ filename: string }[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error) reject(error);
      else resolve(list);
    });
  });
}

function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}

/** Best-effort `mkdir -p`: walks prefixes ignoring "already exists"; the write retries after. */
async function mkdirParents(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (!dir.startsWith("/")) return;
  const parts = dir.split("/").filter((part) => part.length > 0);
  let prefix = "";
  for (const part of parts) {
    prefix += `/${part}`;
    try {
      await sftpMkdir(sftp, prefix);
    } catch {
      // Exists, a permission detail, or a race: the retried write reports the truth.
    }
  }
}

interface RemoteOptions {
  stdin?: string | undefined;
  timeoutSeconds?: number | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Runs one exec channel, streaming output events then exactly one terminal event.
 *
 * Every channel listener is wired synchronously inside the open callback: on a fast (loopback)
 * server the open-confirm, exit-status and channel-close can arrive in one packet batch, which
 * ssh2 dispatches synchronously — anything attached after an `await` would miss a close that
 * already fired and hang forever.
 */
async function* runRemote(
  conn: Client,
  command: string,
  options: RemoteOptions,
): AsyncGenerator<ExecEvent> {
  const events: ExecEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (event: ExecEvent): void => {
    events.push(event);
    wake?.();
  };
  const stdout = new StringDecoder("utf8");
  const stderr = new StringDecoder("utf8");
  let finished: ExecEvent | undefined;
  let timedOut = false;
  let aborted = false;
  const stream = await new Promise<Channel>((resolve, reject) => {
    conn.exec(command, (error, candidate) => {
      if (error) {
        reject(providerError(`exec channel failed: ${errorDetail(error)}`, "provider"));
        return;
      }
      candidate.on("data", (chunk: Buffer) => push({ type: "stdout", text: stdout.write(chunk) }));
      candidate.stderr.on("data", (chunk: Buffer) =>
        push({ type: "stderr", text: stderr.write(chunk) }),
      );
      candidate.once("close", (code: unknown, signal: unknown) => {
        if (timedOut) {
          finished = {
            type: "error",
            code: "aborted",
            message: `exec timed out after ${options.timeoutSeconds} seconds`,
          };
        } else if (aborted) {
          finished = { type: "error", code: "aborted", message: "exec aborted" };
        } else if (typeof signal === "string" && signal.length > 0) {
          finished = {
            type: "error",
            code: "provider",
            message: `command terminated by signal ${signal}`,
          };
        } else if (typeof code === "number") {
          finished = { type: "exit", code };
        } else {
          finished = { type: "error", code: "provider", message: "command ended without a status" };
        }
        wake?.();
      });
      candidate.once("error", (streamError: Error) => {
        finished = {
          type: "error",
          code: "provider",
          message: `exec stream failed: ${errorDetail(streamError)}`,
        };
        wake?.();
      });
      resolve(candidate);
    });
  });
  const timer =
    options.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          stream.destroy();
        }, options.timeoutSeconds * 1000);
  const onAbort = (): void => {
    aborted = true;
    stream.destroy();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // A signal that fired while connecting never triggers the listener: fail fast instead of
    // running a command nobody waits for.
    if (options.signal?.aborted === true) {
      aborted = true;
      stream.destroy();
    }
    if (options.stdin !== undefined) stream.end(options.stdin);
    else stream.end();
    while (finished === undefined || events.length > 0) {
      while (events.length > 0) {
        yield events.shift() as ExecEvent;
      }
      if (finished !== undefined) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    const tailOut = stdout.end();
    if (tailOut.length > 0) yield { type: "stdout", text: tailOut };
    const tailErr = stderr.end();
    if (tailErr.length > 0) yield { type: "stderr", text: tailErr };
    yield finished as ExecEvent;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }
}

/**
 * Creates the ssh-vm provider for one entry (M4-06 AC1). The entry is validated now so a bad
 * provider target fails at wiring time, not at first use; the key loader runs per connection so
 * key material is never held between operations.
 */
export function createSshVmProvider(
  entry: SshVmProviderEntry,
  loadPrivateKey: SshPrivateKeyLoader,
  options: SshVmProviderOptions = {},
): ComputerProvider {
  assertSshVmEntry(entry);
  if (options.imageRef !== undefined) assertSshImageRef(options.imageRef);
  if (typeof loadPrivateKey !== "function") {
    throw new Error("invalid ssh-vm provider: loadPrivateKey must be a function");
  }

  /** Process-lifetime tombstones: `destroy()` is idempotent and reads as `gone` afterwards. */
  const destroyed = new Set<string>();

  const workspaceBase = async (sftp: SFTPWrapper): Promise<string> => {
    if (entry.baseDir !== undefined) return entry.baseDir;
    return `${await sftpRealpath(sftp, ".")}/.opa/computers`;
  };

  const validId = (id: string): boolean =>
    typeof id === "string" &&
    id.startsWith(`${entry.id}-`) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id.slice(entry.id.length + 1),
    );

  const computerDir = async (sftp: SFTPWrapper, providerComputerId: string): Promise<string> => {
    if (!validId(providerComputerId)) throw providerError("unknown computer id", "not_found");
    return `${await workspaceBase(sftp)}/${providerComputerId}`;
  };

  const readHandle = async (
    sftp: SFTPWrapper,
    providerComputerId: string,
  ): Promise<ComputerHandle | null> => {
    const dir = await computerDir(sftp, providerComputerId);
    let raw: Buffer;
    try {
      raw = await sftpReadFile(sftp, `${dir}/${METADATA_NAME}`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw providerError(
        `cannot read computer "${providerComputerId}": ${errorDetail(error)}`,
        "provider",
      );
    }
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as Partial<ComputerHandle>;
      if (
        parsed.providerId !== SSH_VM_PROVIDER_ID ||
        parsed.providerComputerId !== providerComputerId ||
        (parsed.state !== "running" && parsed.state !== "stopped")
      ) {
        throw new Error("metadata shape");
      }
      return parsed as ComputerHandle;
    } catch {
      throw providerError(`computer "${providerComputerId}" metadata is corrupt`, "provider");
    }
  };

  /** Live handle or throw: never-seen ids are `not_found`, destroyed/stopped ones are `gone`. */
  const live = async (sftp: SFTPWrapper, handle: ComputerHandle): Promise<ComputerHandle> => {
    if (handle.providerId !== SSH_VM_PROVIDER_ID)
      throw providerError("foreign provider handle", "not_found");
    if (destroyed.has(handle.providerComputerId)) {
      throw providerError(`computer "${handle.providerComputerId}" is destroyed`, "gone");
    }
    const stored = await readHandle(sftp, handle.providerComputerId);
    if (stored === null) {
      throw providerError(`unknown computer "${handle.providerComputerId}"`, "not_found");
    }
    if (stored.state !== "running") {
      throw providerError(`computer "${handle.providerComputerId}" is ${stored.state}`, "gone");
    }
    return stored;
  };

  const guestPath = (path: string): string => {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
      throw providerError("file path must be a non-empty string without NUL bytes", "invalid_spec");
    }
    return path.startsWith("/") ? path : `/work/${path}`;
  };

  const assertRunning = async (conn: Client, id: string): Promise<void> => {
    const result = await captureRemote(
      conn,
      commandFor(["docker", "inspect", "--format", "{{.State.Running}}", containerName(id)]),
    );
    if (result.code !== 0 || result.stdout.trim() !== "true") {
      throw providerError(`computer "${id}" is not running`, "gone");
    }
  };

  const removeRuntime = async (conn: Client, id: string): Promise<void> => {
    const name = containerName(id);
    const containers = await checkedRemote(conn, [
      "docker",
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^${name}$`,
      "--format",
      "{{.Names}}",
    ]);
    if (containers.split("\n").includes(name)) {
      await checkedRemote(conn, ["docker", "rm", "--force", name]);
    }
    const volume = volumeName(id);
    const volumes = await checkedRemote(conn, [
      "docker",
      "volume",
      "ls",
      "--filter",
      `name=^${volume}$`,
      "--format",
      "{{.Name}}",
    ]);
    if (volumes.split("\n").includes(volume)) {
      await checkedRemote(conn, ["docker", "volume", "rm", volume]);
    }
  };

  const loadKey = async (): Promise<string> => loadPrivateKey().catch(wrapKeyError);

  return {
    id: SSH_VM_PROVIDER_ID,

    async create(spec): Promise<ComputerHandle> {
      assertComputerSpec(spec);
      if (!SSH_VM_PROFILES.includes(spec.profile)) {
        throw new ComputerProviderError(
          `provider "${SSH_VM_PROVIDER_ID}" does not offer the "${spec.profile}" profile`,
          "unsupported",
        );
      }
      if (spec.egressHosts !== undefined && spec.egressHosts.length > 0) {
        throw new ComputerProviderError(
          `provider "${SSH_VM_PROVIDER_ID}" cannot enforce an egress allowlist`,
          "unsupported",
        );
      }
      return withConnection(entry, loadKey, async (conn) => {
        const sftp = await sftpOf(conn);
        try {
          // Guest probe first: fail closed naming the gap before allocating anything.
          const probe = `for c in ${GUEST_TOOLS.join(" ")}; do command -v "$c" >/dev/null 2>&1 || printf 'MISSING:%s\\n' "$c"; done; exit 0`;
          let probeCode: number | undefined;
          const missing: string[] = [];
          for await (const event of runRemote(conn, probe, {})) {
            if (event.type === "stdout") {
              for (const line of event.text.split("\n")) {
                if (line.startsWith("MISSING:")) missing.push(line.slice("MISSING:".length));
              }
            } else if (event.type === "exit") {
              probeCode = event.code;
            } else if (event.type === "error") {
              throw providerError(`guest probe failed: ${event.message}`, "provider");
            }
          }
          if (probeCode !== 0) {
            throw providerError(`guest probe exited with code ${probeCode}`, "provider");
          }
          if (missing.length > 0) {
            throw providerError(
              `guest is missing required tools: ${missing.join(", ")}`,
              "provider",
            );
          }
          // Resolve the shared build's cache tag once per create. Only the immutable image Id
          // reaches `docker run`; never pull, build or substitute a host-shell fallback.
          const imageId = await checkedRemote(conn, [
            "docker",
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            options.imageRef ?? SSH_COMPUTER_IMAGE_TAG,
          ]);
          assertSshImageRef(imageId);
          const base = await workspaceBase(sftp);
          let providerComputerId = "";
          for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
            const candidate = `${entry.id}-${randomUUID()}`;
            try {
              await sftpStat(sftp, `${base}/${candidate}`);
            } catch (error) {
              if (isNotFound(error)) {
                providerComputerId = candidate;
                break;
              }
              throw providerError(
                `cannot allocate computer directory: ${errorDetail(error)}`,
                "provider",
              );
            }
          }
          if (providerComputerId.length === 0) {
            throw providerError("cannot allocate a unique computer directory", "provider");
          }
          const dir = `${base}/${providerComputerId}`;
          // mkdir -p covers a missing baseDir; the leaf mkdir is the atomic create (the
          // candidate was stat-checked just above, so an existing leaf is a real collision).
          await mkdirParents(sftp, base);
          try {
            await sftpMkdir(sftp, dir);
          } catch (error) {
            throw providerError(
              `cannot create computer directory: ${errorDetail(error)}`,
              "provider",
            );
          }
          const createdAt = new Date();
          const handle: ComputerHandle = {
            providerId: SSH_VM_PROVIDER_ID,
            providerComputerId,
            profile: spec.profile,
            state: "running",
            createdAt: createdAt.toISOString(),
            idleDeadlineAt: new Date(
              createdAt.getTime() + spec.idleTimeoutSeconds * 1000,
            ).toISOString(),
            lifetimeDeadlineAt: new Date(
              createdAt.getTime() + spec.maxLifetimeSeconds * 1000,
            ).toISOString(),
          };
          try {
            // Persist before allocating runtime resources so a failed launch is discoverable
            // and destroy() can finish cleanup even after a control-plane restart.
            await sftpWriteFile(
              sftp,
              `${dir}/${METADATA_NAME}`,
              new TextEncoder().encode(
                `${JSON.stringify({ ...handle, state: "stopped" }, null, 2)}\n`,
              ),
            );
            await checkedRemote(conn, [
              "docker",
              "run",
              "--detach",
              "--pull=never",
              "--name",
              containerName(providerComputerId),
              "--label",
              "opa.provider=ssh-vm",
              "--label",
              `opa.entry=${entry.id}`,
              "--user",
              SSH_COMPUTER_UID,
              "--cap-drop=ALL",
              "--security-opt=no-new-privileges",
              "--pids-limit=256",
              "--memory=512m",
              "--cpus=1",
              "--mount",
              `type=volume,source=${volumeName(providerComputerId)},target=/work`,
              "--workdir=/work",
              imageId,
              "sleep",
              "infinity",
            ]);
            await sftpWriteFile(
              sftp,
              `${dir}/${METADATA_NAME}`,
              new TextEncoder().encode(`${JSON.stringify(handle, null, 2)}\n`),
            );
          } catch (error) {
            // Keep the stopped record if cleanup fails: list()/destroy() can recover the
            // exact resource names instead of silently orphaning a running computer.
            try {
              await removeRuntime(conn, providerComputerId);
              await checkedRemote(conn, ["rm", "-rf", "--", dir]);
            } catch {
              throw providerError(
                `create failed; cleanup required for "${providerComputerId}": ${errorDetail(error)}`,
                "provider",
              );
            }
            throw providerError(`cannot create computer: ${errorDetail(error)}`, "provider");
          }
          return { ...handle };
        } finally {
          sftp.end();
        }
      });
    },

    exec(handle: ComputerHandle, request: ExecRequest): AsyncIterable<ExecEvent> {
      if (!sshVmCapabilities().surfaces.execStream) throw unsupported("exec stream");
      assertValidRequest(request);
      const options: RemoteOptions = {
        stdin: request.stdin,
        timeoutSeconds: request.timeoutSeconds,
        signal: request.signal,
      };
      return (async function* (): AsyncGenerator<ExecEvent> {
        if (request.signal?.aborted) {
          yield { type: "error", code: "aborted", message: "exec aborted" };
          return;
        }
        // Lifecycle state lives on the VM across the network: unknown, stopped and destroyed
        // computers report here as terminal error events carrying the same codes throws use.
        let conn: Client | undefined;
        try {
          try {
            conn = await openConnection(entry, await loadKey());
          } catch (error) {
            yield toTerminal(error);
            return;
          }
          const sftp = await sftpOf(conn);
          try {
            await live(sftp, handle);
            await assertRunning(conn, handle.providerComputerId);
          } catch (error) {
            sftp.end();
            yield toTerminal(error);
            return;
          }
          sftp.end();
          if (request.signal?.aborted) {
            yield { type: "error", code: "aborted", message: "exec aborted" };
            return;
          }
          const executionId = randomUUID();
          let settled = false;
          try {
            for await (const event of runRemote(
              conn,
              computerCommand(handle.providerComputerId, request, executionId),
              options,
            )) {
              if (event.type === "error") {
                await cancelComputerExec(conn, handle.providerComputerId, executionId);
                settled = true;
              } else if (event.type === "exit") settled = true;
              yield event;
            }
          } finally {
            // Also cover a caller returning early from the output iterator.
            if (!settled) await cancelComputerExec(conn, handle.providerComputerId, executionId);
          }
        } catch (error) {
          yield toTerminal(error);
        } finally {
          conn?.destroy();
        }
      })();
    },

    async putFile(handle: ComputerHandle, path: string, data: Uint8Array): Promise<void> {
      if (!sshVmCapabilities().surfaces.files) throw unsupported("files");
      const conn = await openConnection(entry, await loadKey());
      try {
        const sftp = await sftpOf(conn);
        try {
          await live(sftp, handle);
          await assertRunning(conn, handle.providerComputerId);
          const target = guestPath(path);
          const parent = target.slice(0, target.lastIndexOf("/")) || "/";
          const script = `mkdir -p -- ${quoteForSh(parent)} && base64 -d > ${quoteForSh(target)}`;
          const result = await captureRemote(
            conn,
            commandFor([
              "docker",
              "exec",
              "-i",
              containerName(handle.providerComputerId),
              "sh",
              "-c",
              script,
            ]),
            Buffer.from(data).toString("base64"),
          );
          if (result.code !== 0)
            throw providerError(`cannot write file "${path}" (exit ${result.code})`, "provider");
        } finally {
          sftp.end();
        }
      } finally {
        conn.destroy();
      }
    },

    async getFile(handle: ComputerHandle, path: string): Promise<Uint8Array> {
      if (!sshVmCapabilities().surfaces.files) throw unsupported("files");
      const conn = await openConnection(entry, await loadKey());
      try {
        const sftp = await sftpOf(conn);
        try {
          await live(sftp, handle);
          await assertRunning(conn, handle.providerComputerId);
          const target = guestPath(path);
          const script = `test -f ${quoteForSh(target)} || exit 44; base64 < ${quoteForSh(target)}`;
          const result = await captureRemote(
            conn,
            commandFor([
              "docker",
              "exec",
              containerName(handle.providerComputerId),
              "sh",
              "-c",
              script,
            ]),
          );
          if (result.code === 44) throw providerError(`file "${path}" not found`, "not_found");
          if (result.code !== 0)
            throw providerError(`cannot read file "${path}" (exit ${result.code})`, "provider");
          return new Uint8Array(Buffer.from(result.stdout, "base64"));
        } finally {
          sftp.end();
        }
      } finally {
        conn.destroy();
      }
    },

    async exportArtifact(
      handle: ComputerHandle,
      path: string,
    ): Promise<{ name: string; data: Uint8Array }> {
      if (!sshVmCapabilities().surfaces.files) throw unsupported("files");
      const data = await this.getFile(handle, path);
      const name = path.split("/").pop() ?? path;
      return { name, data };
    },

    async stop(handle: ComputerHandle): Promise<void> {
      const conn = await openConnection(entry, await loadKey());
      try {
        const sftp = await sftpOf(conn);
        try {
          if (destroyed.has(handle.providerComputerId)) {
            throw providerError(`computer "${handle.providerComputerId}" is destroyed`, "gone");
          }
          const stored = await readHandle(sftp, handle.providerComputerId);
          if (stored === null) {
            throw providerError(`unknown computer "${handle.providerComputerId}"`, "not_found");
          }
          if (handle.providerId !== SSH_VM_PROVIDER_ID)
            throw providerError("foreign provider handle", "not_found");
          if (stored.state === "stopped") return;
          await checkedRemote(conn, [
            "docker",
            "stop",
            "--time=5",
            containerName(stored.providerComputerId),
          ]);
          const dir = await computerDir(sftp, stored.providerComputerId);
          try {
            await sftpWriteFile(
              sftp,
              `${dir}/${METADATA_NAME}`,
              new TextEncoder().encode(
                `${JSON.stringify({ ...stored, state: "stopped" }, null, 2)}\n`,
              ),
            );
          } catch (error) {
            throw providerError(`cannot stop computer: ${errorDetail(error)}`, "provider");
          }
        } finally {
          sftp.end();
        }
      } finally {
        conn.destroy();
      }
    },

    async destroy(handle: ComputerHandle): Promise<void> {
      if (destroyed.has(handle.providerComputerId)) return; // idempotent
      const conn = await openConnection(entry, await loadKey());
      try {
        const sftp = await sftpOf(conn);
        let dir: string;
        try {
          const stored = await readHandle(sftp, handle.providerComputerId);
          if (stored === null) {
            throw providerError(`unknown computer "${handle.providerComputerId}"`, "not_found");
          }
          dir = await computerDir(sftp, stored.providerComputerId);
        } finally {
          sftp.end();
        }
        if (handle.providerId !== SSH_VM_PROVIDER_ID)
          throw providerError("foreign provider handle", "not_found");
        await removeRuntime(conn, handle.providerComputerId);
        // Metadata is removed last; an interrupted cleanup remains discoverable for retry.
        await checkedRemote(conn, ["rm", "-rf", "--", dir]);
        destroyed.add(handle.providerComputerId);
      } finally {
        conn.destroy();
      }
    },

    async list(): Promise<ComputerHandle[]> {
      const conn = await openConnection(entry, await loadKey());
      try {
        const sftp = await sftpOf(conn);
        try {
          const base = await workspaceBase(sftp);
          let entries: { filename: string }[];
          try {
            entries = await sftpReaddir(sftp, base);
          } catch (error) {
            if (isNotFound(error)) return [];
            throw providerError(`cannot list computers: ${errorDetail(error)}`, "provider");
          }
          const handles: ComputerHandle[] = [];
          for (const item of entries) {
            if (!validId(item.filename)) continue;
            try {
              const raw = await sftpReadFile(sftp, `${base}/${item.filename}/${METADATA_NAME}`);
              const parsed = JSON.parse(raw.toString("utf8")) as Partial<ComputerHandle>;
              if (
                parsed.providerId !== SSH_VM_PROVIDER_ID ||
                parsed.providerComputerId !== item.filename ||
                (parsed.state !== "running" && parsed.state !== "stopped")
              ) {
                continue;
              }
              handles.push(parsed as ComputerHandle);
            } catch {}
          }
          if (handles.length === 0) return [];
          const names = await checkedRemote(conn, [
            "docker",
            "container",
            "ls",
            "--filter",
            "label=opa.provider=ssh-vm",
            "--filter",
            `label=opa.entry=${entry.id}`,
            "--format",
            "{{.Names}}",
          ]);
          const running = new Set(names.split("\n"));
          return handles.map((handle) => ({
            ...handle,
            state:
              handle.state === "running" && running.has(containerName(handle.providerComputerId))
                ? "running"
                : "stopped",
          }));
        } finally {
          sftp.end();
        }
      } finally {
        conn.destroy();
      }
    },

    capabilities(): ComputerCapabilities {
      return sshVmCapabilities();
    },
  };
}

/** Terminal exec event for a failure: preserves provider codes, wraps anything else. */
function toTerminal(error: unknown): ExecEvent {
  if (error instanceof ComputerProviderError) {
    return { type: "error", code: error.code, message: error.message };
  }
  return { type: "error", code: "provider", message: `ssh-vm provider: ${errorDetail(error)}` };
}
