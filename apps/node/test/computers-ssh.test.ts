// SPDX-License-Identifier: Apache-2.0
// M4-06 coverage: the ssh-vm provider passes the M4-01 conformance suite over real SSH
// (loopback sshd, AC1), declares the honest capabilities (AC2), and keeps the credential out of
// the computer (key-canary tests, AC1). In-process ssh2 server tests cover host-key pinning,
// auth failure, argv quoting shape, timeout and abort without a guest OS; vault tests cover the
// credential binding domain separation. Suites needing sshd or sftp-server skip where absent.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertComputerCapabilities,
  type ComputerHandle,
  ComputerProviderError,
  checkComputerProvider,
  createComputerProviderRegistry,
  createComputerSpec,
  type SshVmProviderEntry,
  sshCredentialBinding,
} from "@opa/core";
import {
  createVault,
  decrypt,
  encrypt,
  type SealedSecret,
  type UserScope,
  type Vault,
  type VaultAuditRow,
  type VaultStore,
  type WrappedDek,
} from "@opa/vault";
import { type Channel, Server } from "ssh2";
import { describe, expect, it } from "vitest";
import {
  createSshVmProvider,
  loadSshPrivateKey,
  quoteForSh,
  remoteCommand,
} from "../src/computers-ssh";

// ssh2's key parser takes node:crypto RSA pkcs1 PEMs and ssh-keygen OpenSSH ed25519 PEMs, but
// not node:crypto pkcs8 — so every test keypair here is RSA pkcs1, generated hermetically.
function makeKeyPair(): { privatePem: string; publicKey: KeyObject } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey: pair.publicKey,
  };
}

const b64url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function mpint(raw: Buffer): Buffer {
  const bytes =
    raw[0] !== undefined && (raw[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), raw]) : raw;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** The SSH wire encoding of an RSA public key: string "ssh-rsa" + mpint e + mpint n. */
function rsaWireFormat(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "RSA" || typeof jwk.e !== "string" || typeof jwk.n !== "string") {
    throw new Error("expected an RSA public key");
  }
  const name = Buffer.from("ssh-rsa");
  const nameLength = Buffer.alloc(4);
  nameLength.writeUInt32BE(name.length);
  return Buffer.concat([nameLength, name, mpint(b64url(jwk.e)), mpint(b64url(jwk.n))]);
}

/** The `SHA256:` pin for a host key, computed independently of the provider's hasher. */
function hostPin(publicKey: KeyObject): string {
  return `SHA256:${createHash("sha256").update(rsaWireFormat(publicKey)).digest("base64")}`;
}

/** An `authorized_keys` line for an RSA public key. */
function authorizedKeysLine(publicKey: KeyObject): string {
  return `ssh-rsa ${rsaWireFormat(publicKey).toString("base64")} test\n`;
}

/** Minimal in-memory `VaultStore` for the binding tests: encrypt/decrypt path only. */
class StubStore implements VaultStore {
  keys: WrappedDek[] = [];
  secrets: SealedSecret[] = [];
  audits: VaultAuditRow[] = [];
  async userKeys(userId: string): Promise<WrappedDek[]> {
    return this.keys.filter((key) => key.userId === userId);
  }
  async userKeysAt(kekVersion: number, limit: number): Promise<WrappedDek[]> {
    return this.keys.filter((key) => key.kekVersion === kekVersion).slice(0, limit);
  }
  async countUserKeys(kekVersion: number): Promise<number> {
    return this.keys.filter((key) => key.kekVersion === kekVersion).length;
  }
  async countOrphans(_heldEpochs: number[]): Promise<number> {
    return 0;
  }
  async insertUserKey(row: WrappedDek): Promise<void> {
    this.keys.push(row);
  }
  async userSecrets(userId: string): Promise<SealedSecret[]> {
    return this.secrets.filter((secret) => secret.userId === userId);
  }
  async rekeyUser(_change: Parameters<VaultStore["rekeyUser"]>[0]): Promise<boolean> {
    throw new Error("unimplemented");
  }
  async getSecret(userId: string, secretId: string): Promise<SealedSecret | null> {
    return (
      this.secrets.find((secret) => secret.userId === userId && secret.id === secretId) ?? null
    );
  }
  async putSecret(row: SealedSecret, dek: WrappedDek, audit: VaultAuditRow): Promise<void> {
    if (!this.keys.includes(dek)) throw new Error("unknown dek");
    this.secrets = [...this.secrets.filter((secret) => secret.id !== row.id), row];
    this.audits.push(audit);
  }
  async resetUser(_keys: WrappedDek[], _audit: VaultAuditRow): Promise<boolean> {
    throw new Error("unimplemented");
  }
  async audit(row: VaultAuditRow): Promise<void> {
    this.audits.push(row);
  }
}

const MASTER_KEY = Buffer.from(createHash("sha256").update("test-master").digest()).toString(
  "base64",
);

async function testVault(): Promise<{ vault: Vault; scope: UserScope }> {
  const vault = await createVault({ masterKey: MASTER_KEY, store: new StubStore() });
  return { vault, scope: { userId: "u1" } as UserScope };
}

function testEntry(overrides: Partial<SshVmProviderEntry> = {}): SshVmProviderEntry {
  const host = makeKeyPair();
  return {
    id: "test-vm",
    host: "127.0.0.1",
    username: "test",
    hostKeyPins: [hostPin(host.publicKey)],
    credentialSecretId: "ssh-test",
    ...overrides,
  };
}

/** A computer handle the provider has never seen (lifecycle checks are async, so any shape). */
function unknownHandle(): ComputerHandle {
  return {
    providerId: "ssh-vm",
    providerComputerId: "test-vm-never-created",
    profile: "standard",
    state: "running",
    createdAt: new Date().toISOString(),
    idleDeadlineAt: new Date(Date.now() + 300_000).toISOString(),
    lifetimeDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

describe("quoting and remote command", () => {
  it("single-quotes argv elements so none can break out", () => {
    expect(quoteForSh("echo")).toBe("'echo'");
    expect(quoteForSh("hello world")).toBe("'hello world'");
    expect(quoteForSh("a'b")).toBe("'a'\\''b'");
    expect(quoteForSh("")).toBe("''");
    expect(quoteForSh("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(quoteForSh("`id`")).toBe("'`id`'");
    expect(quoteForSh("line1\nline2")).toBe("'line1\nline2'");
    expect(quoteForSh("--flag=x")).toBe("'--flag=x'");
  });

  it("builds the guarded cd/export/exec script", () => {
    expect(remoteCommand("/w", { argv: ["echo", "hi"] })).toBe(
      "cd '/w' || exit 127; exec 'echo' 'hi'",
    );
    expect(remoteCommand("/w", { argv: ["pwd"], cwd: "sub dir" })).toBe(
      "cd '/w' || exit 127; cd '/w/sub dir' || exit 127; exec 'pwd'",
    );
    expect(remoteCommand("/w", { argv: ["pwd"], cwd: "/tmp" })).toBe(
      "cd '/w' || exit 127; cd '/tmp' || exit 127; exec 'pwd'",
    );
    expect(remoteCommand("/w", { argv: ["env"], env: { A: "b c", B: "x'y" } })).toBe(
      "cd '/w' || exit 127; export A='b c' B='x'\\''y'; exec 'env'",
    );
  });
});

describe("capabilities and wiring", () => {
  it("declares the honest ssh-vm shape (AC2)", () => {
    const provider = createSshVmProvider(testEntry(), async () => "key");
    const capabilities = provider.capabilities();
    expect(provider.id).toBe("ssh-vm");
    expect(capabilities.credentialDelivery).toBe("proxy-token");
    expect(capabilities.egressControl).toBe("none");
    expect(capabilities.profiles).toEqual(["standard", "persistent"]);
    expect(capabilities.persistentDisk).toBe(true);
    expect(capabilities.surfaces).toEqual({
      execStream: true,
      files: true,
      browser: false,
      desktop: false,
      snapshot: false,
      preview: false,
    });
    expect(() => assertComputerCapabilities(capabilities)).not.toThrow();
  });

  it("returns a fresh capabilities copy per call", () => {
    const provider = createSshVmProvider(testEntry(), async () => "key");
    provider.capabilities().surfaces.execStream = false;
    expect(provider.capabilities().surfaces.execStream).toBe(true);
  });

  it("registers in the M4-01 provider registry", () => {
    const provider = createSshVmProvider(testEntry(), async () => "key");
    const registry = createComputerProviderRegistry([provider]);
    expect(registry.get("ssh-vm")).toBe(provider);
    expect(registry.resolveDefault("ssh-vm")).toBe(provider);
  });

  it("rejects a malformed entry at construction, not at first use", () => {
    expect(() => createSshVmProvider(testEntry({ host: "has space" }), async () => "key")).toThrow(
      "invalid ssh-vm provider entry",
    );
    expect(() =>
      createSshVmProvider(testEntry(), "not-a-function" as unknown as () => Promise<string>),
    ).toThrow("loadPrivateKey must be a function");
  });

  it("refuses profiles and egress it cannot enforce (AC2)", async () => {
    const provider = createSshVmProvider(testEntry(), async () => "key");
    await expect(
      provider.create(createComputerSpec({ profile: "authenticated_browser" })),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      provider.create(createComputerSpec({ profile: "standard", egressHosts: ["example.com"] })),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("throws invalid_spec synchronously for malformed exec requests", () => {
    const provider = createSshVmProvider(testEntry(), async () => "key");
    expect(() => provider.exec(unknownHandle(), { argv: [] })).toThrow(
      expect.objectContaining({ code: "invalid_spec" }),
    );
    expect(() =>
      provider.exec(unknownHandle(), { argv: ["echo"], env: { "bad-name": "x" } }),
    ).toThrow(expect.objectContaining({ code: "invalid_spec" }));
  });
});

describe("vault credential binding", () => {
  it("loads the key saved for the entry (AC1)", async () => {
    const { vault, scope } = await testVault();
    const entry = testEntry();
    const key = "fake-private-key-material";
    await encrypt(vault, scope, {
      secretId: entry.credentialSecretId,
      purpose: "ssh_private_key",
      binding: sshCredentialBinding(entry),
      plaintext: key,
      caller: "test",
    });
    await expect(loadSshPrivateKey(vault, scope, entry)).resolves.toBe(key);
  });

  it("refuses a key saved for another entry, purpose or binding", async () => {
    const { vault, scope } = await testVault();
    const entry = testEntry();
    const key = "fake-private-key-material";
    await encrypt(vault, scope, {
      secretId: entry.credentialSecretId,
      purpose: "ssh_private_key",
      binding: sshCredentialBinding(entry),
      plaintext: key,
      caller: "test",
    });
    const other = testEntry({ id: "other-vm" });
    await expect(loadSshPrivateKey(vault, scope, other)).rejects.toThrow("decrypt_failed");
    // Same id and binding, different purpose: the AAD domain still separates it.
    await expect(
      decrypt(vault, scope, {
        secretId: entry.credentialSecretId,
        purpose: "model_api_key",
        binding: sshCredentialBinding(entry),
        caller: "test",
      }),
    ).rejects.toThrow("decrypt_failed");
  });
});

// In-process SSH server tests: real SSH wire auth, host-key verification and exec capture, no
// guest OS. The sftp subsystem is piped to the system sftp-server so metadata and file
// operations run against the local filesystem.
const SFTP_SERVER = ["/usr/lib/openssh/sftp-server", "/usr/libexec/sftp-server"].find((path) =>
  existsSync(path),
);

interface ScriptServer {
  port: number;
  commands: string[];
  close(): Promise<void>;
}

async function startScriptServer(options: {
  hostKeyPem: string;
  acceptPublicKey: boolean;
  onExec: (command: string, stream: Channel) => void;
}): Promise<ScriptServer> {
  const commands: string[] = [];
  const children: ChildProcess[] = [];
  const server = new Server({ hostKeys: [options.hostKeyPem] }, (conn) => {
    // Teardown races (client destroys its socket while the server still has queued writes, or a
    // live sftp-server child outlives its channel) surface as EPIPE/ECONNRESET here, and a
    // client that aborts the handshake (the pin/auth negative tests refuse it) as a DISCONNECT
    // error carrying a numeric reason code. Real sshd absorbs those; this double must too, or
    // every negative test logs an unhandled error. Anything else still crashes loudly: that
    // would be a real test-double bug.
    conn.on("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPIPE" || code === "ECONNRESET" || typeof code === "number") return;
      throw error;
    });
    conn.on("authentication", (ctx) => {
      if (ctx.method === "publickey" && options.acceptPublicKey) ctx.accept();
      else ctx.reject();
    });
    conn.on("ready", () => {
      conn.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _rejectExec, info) => {
          commands.push(info.command);
          options.onExec(info.command, acceptExec());
        });
        session.on("subsystem", (acceptSub, rejectSub, info) => {
          if (info.name !== "sftp" || SFTP_SERVER === undefined) {
            rejectSub();
            return;
          }
          const stream = acceptSub();
          const child = spawn(SFTP_SERVER, [], { stdio: ["pipe", "pipe", "ignore"] });
          children.push(child);
          stream.pipe(child.stdin);
          child.stdout.pipe(stream);
          child.on("error", () => stream.destroy());
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server has no address");
  return {
    port: address.port,
    commands,
    // Kill the sftp-server children first: otherwise a child writing to a torn-down pipe can
    // surface as an uncaught EPIPE after the test already passed.
    close: async () => {
      for (const child of children) child.kill();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function scriptEntry(
  server: ScriptServer,
  host: KeyObject,
  overrides: Partial<SshVmProviderEntry> = {},
): SshVmProviderEntry {
  return testEntry({
    host: "127.0.0.1",
    port: server.port,
    ...overrides,
    hostKeyPins: [hostPin(host)],
  });
}

describe("ssh transport", () => {
  it("refuses a host key that is not pinned (no TOFU)", async () => {
    const host = makeKeyPair();
    const other = makeKeyPair();
    const key = makeKeyPair();
    const server = await startScriptServer({
      hostKeyPem: host.privatePem,
      acceptPublicKey: true,
      onExec: (_command, stream) => {
        stream.exit(0);
        stream.end();
      },
    });
    try {
      // The server presents `host`'s key; the entry pins `other`'s. The client key is valid so
      // the handshake reaches host verification (an unparsable key would fail before that).
      const provider = createSshVmProvider(
        scriptEntry(server, other.publicKey),
        async () => key.privatePem,
      );
      await expect(provider.list()).rejects.toThrow(/host key|verification/i);
    } finally {
      await server.close();
    }
  });

  it("refuses authentication failure without leaking the key", async () => {
    const host = makeKeyPair();
    const key = makeKeyPair();
    const server = await startScriptServer({
      hostKeyPem: host.privatePem,
      acceptPublicKey: false,
      onExec: (_command, stream) => {
        stream.exit(0);
        stream.end();
      },
    });
    try {
      const provider = createSshVmProvider(
        scriptEntry(server, host.publicKey),
        async () => key.privatePem,
      );
      const failure = await provider.list().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ComputerProviderError);
      expect((failure as ComputerProviderError).code).toBe("provider");
      expect((failure as Error).message).not.toContain(key.privatePem);
    } finally {
      await server.close();
    }
  });

  it.skipIf(SFTP_SERVER === undefined)(
    "delivers the exact quoted command and never the key",
    async () => {
      const host = makeKeyPair();
      const key = makeKeyPair();
      const baseDir = mkdtempSync(join(tmpdir(), "ssh-vm-shape-"));
      const server = await startScriptServer({
        hostKeyPem: host.privatePem,
        acceptPublicKey: true,
        onExec: (_command, stream) => {
          stream.stdout.write("marker\n");
          stream.exit(0);
          stream.end();
        },
      });
      try {
        const provider = createSshVmProvider(
          scriptEntry(server, host.publicKey, { baseDir }),
          async () => key.privatePem,
        );
        const handle = await provider.create(createComputerSpec({ profile: "persistent" }));
        const request = {
          argv: ["printf", "%s", "a'b $(id)"],
          cwd: "sub dir",
          env: { GREETING: "hi there" },
          stdin: "input bytes",
        };
        const events = [];
        for await (const event of provider.exec(handle, request)) events.push(event);
        expect(events).toEqual([
          { type: "stdout", text: "marker\n" },
          { type: "exit", code: 0 },
        ]);
        // `create` probes the guest first, then runs the exec: the quoted command is the last one.
        expect(server.commands).toHaveLength(2);
        const dir = `${baseDir}/${handle.providerComputerId}`;
        expect(server.commands[1]).toBe(remoteCommand(dir, request));
        // Key canary: nothing the guest received contains the private key.
        expect(server.commands.join("\n")).not.toContain(key.privatePem);
        await provider.destroy(handle);
      } finally {
        await server.close();
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(SFTP_SERVER === undefined)(
    "reports unknown and stopped computers as error events",
    async () => {
      const host = makeKeyPair();
      const key = makeKeyPair();
      const baseDir = mkdtempSync(join(tmpdir(), "ssh-vm-lifecycle-"));
      const server = await startScriptServer({
        hostKeyPem: host.privatePem,
        acceptPublicKey: true,
        onExec: (_command, stream) => {
          stream.exit(0);
          stream.end();
        },
      });
      const collect = async (
        provider: ReturnType<typeof createSshVmProvider>,
        handle: ComputerHandle,
      ) => {
        const events = [];
        for await (const event of provider.exec(handle, { argv: ["echo", "hi"] }))
          events.push(event);
        return events;
      };
      try {
        const provider = createSshVmProvider(
          scriptEntry(server, host.publicKey, { baseDir }),
          async () => key.privatePem,
        );
        expect(await collect(provider, unknownHandle())).toEqual([
          expect.objectContaining({ type: "error", code: "not_found" }),
        ]);
        const handle = await provider.create(createComputerSpec({ profile: "standard" }));
        await provider.stop(handle);
        expect(await collect(provider, handle)).toEqual([
          expect.objectContaining({ type: "error", code: "gone" }),
        ]);
        await provider.destroy(handle);
        expect(await collect(provider, handle)).toEqual([
          expect.objectContaining({ type: "error", code: "gone" }),
        ]);
      } finally {
        await server.close();
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
    // Seven SSH connections plus two RSA keygens: ~6s on a loaded box, over the 5s default.
    30_000,
  );

  it.skipIf(SFTP_SERVER === undefined)(
    "times out a hung command as an aborted error event",
    async () => {
      const host = makeKeyPair();
      const key = makeKeyPair();
      const baseDir = mkdtempSync(join(tmpdir(), "ssh-vm-timeout-"));
      const server = await startScriptServer({
        hostKeyPem: host.privatePem,
        acceptPublicKey: true,
        // Answers the create-time guest probe, but never the sleep: the client must give up on
        // its own deadline.
        onExec: (command, stream) => {
          if (command.includes("sleep")) return;
          stream.exit(0);
          stream.end();
        },
      });
      try {
        const provider = createSshVmProvider(
          scriptEntry(server, host.publicKey, { baseDir }),
          async () => key.privatePem,
        );
        const handle = await provider.create(createComputerSpec({ profile: "standard" }));
        const events = [];
        for await (const event of provider.exec(handle, {
          argv: ["sleep", "30"],
          timeoutSeconds: 1,
        })) {
          events.push(event);
        }
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: "error", code: "aborted" });
        await provider.destroy(handle);
      } finally {
        await server.close();
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(SFTP_SERVER === undefined)(
    "aborts on AbortSignal as an aborted error event",
    async () => {
      const host = makeKeyPair();
      const key = makeKeyPair();
      const baseDir = mkdtempSync(join(tmpdir(), "ssh-vm-abort-"));
      const server = await startScriptServer({
        hostKeyPem: host.privatePem,
        acceptPublicKey: true,
        // Answers the create-time guest probe, but never the sleep: only the AbortSignal ends it.
        onExec: (command, stream) => {
          if (command.includes("sleep")) return;
          stream.exit(0);
          stream.end();
        },
      });
      try {
        const provider = createSshVmProvider(
          scriptEntry(server, host.publicKey, { baseDir }),
          async () => key.privatePem,
        );
        const handle = await provider.create(createComputerSpec({ profile: "standard" }));
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const events = [];
        for await (const event of provider.exec(handle, {
          argv: ["sleep", "30"],
          signal: controller.signal,
        })) {
          events.push(event);
        }
        expect(events).toEqual([expect.objectContaining({ type: "error", code: "aborted" })]);
        await provider.destroy(handle);
      } finally {
        await server.close();
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// Loopback OpenSSH tests: the M4-01 conformance suite against a real guest shell and filesystem
// (AC1). Skipped where sshd is unavailable; a present-but-broken sshd fails loudly.
const SSHD = ["/usr/sbin/sshd", "/usr/libexec/sshd", "/usr/lib/ssh/sshd"].find((path) =>
  existsSync(path),
);

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const sshdBinary = SSHD ?? findOnPath("sshd");

interface SshdFixture {
  entry: SshVmProviderEntry;
  privateKey: string;
  dir: string;
  baseDir: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then(({ createServer }) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (typeof address === "object" && address !== null) resolve(address.port);
          else reject(new Error("no port"));
        });
      });
    }, reject);
  });
}

async function startSshd(): Promise<SshdFixture> {
  const dir = mkdtempSync(join(tmpdir(), "ssh-vm-sshd-"));
  const host = makeKeyPair();
  const key = makeKeyPair();
  const hostPath = join(dir, "host");
  const authPath = join(dir, "authorized_keys");
  writeFileSync(hostPath, host.privatePem, { mode: 0o600 });
  writeFileSync(authPath, authorizedKeysLine(key.publicKey), { mode: 0o600 });
  const baseDir = join(dir, "computers");
  const port = await freePort();
  const logPath = join(dir, "sshd.log");
  const pidPath = join(dir, "sshd.pid");
  const username = execFileSync("whoami", { encoding: "utf8" }).trim();
  let child: ChildProcess | undefined;
  const args = [
    "-p",
    String(port),
    "-h",
    hostPath,
    "-o",
    `PidFile=${pidPath}`,
    "-o",
    `AuthorizedKeysFile=${authPath}`,
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "PubkeyAuthentication=yes",
    "-o",
    "ChallengeResponseAuthentication=no",
    "-o",
    "UsePAM=no",
    "-o",
    "StrictModes=no",
    "-o",
    "LogLevel=ERROR",
    "-E",
    logPath,
  ];
  child = spawn(sshdBinary as string, args, { stdio: "ignore" });
  const stop = async (): Promise<void> => {
    child?.kill();
    child = undefined;
    await new Promise((resolve) => setTimeout(resolve, 200));
    rmSync(dir, { recursive: true, force: true });
  };
  // Poll for readiness: a present-but-broken sshd fails the suite, it does not skip it.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await new Promise<void>((resolve, reject) => {
        import("node:net").then(({ connect }) => {
          const socket = connect(port, "127.0.0.1", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        }, reject);
      });
      break;
    } catch {
      if (Date.now() > deadline || child?.exitCode !== null) {
        const log = existsSync(logPath)
          ? readFileSync(logPath, "utf8")
              .replaceAll(host.privatePem, "[redacted]")
              .replaceAll(key.privatePem, "[redacted]")
              .replaceAll(dir, "<fixture>")
              .slice(-4096)
          : "no startup log";
        const exitCode = child?.exitCode;
        await stop();
        throw new Error(`test sshd did not start (exit ${exitCode}): ${log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    entry: {
      id: "lab-vm",
      host: "127.0.0.1",
      port,
      username,
      hostKeyPins: [hostPin(host.publicKey)],
      credentialSecretId: "ssh-lab",
      baseDir,
    },
    privateKey: key.privatePem,
    dir,
    baseDir,
    stop,
  };
}

describe.skipIf(sshdBinary === undefined)("loopback openssh", () => {
  it("passes the M4-01 conformance suite over SSH (AC1)", async () => {
    const sshd = await startSshd();
    try {
      const provider = createSshVmProvider(sshd.entry, async () => sshd.privateKey);
      await checkComputerProvider(provider);
    } finally {
      await sshd.stop();
    }
  }, 120_000);

  it("names artifacts by basename and reads stopped computers as gone", async () => {
    const sshd = await startSshd();
    try {
      const provider = createSshVmProvider(sshd.entry, async () => sshd.privateKey);
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      await provider.putFile(handle, "notes/report.txt", new TextEncoder().encode("bytes"));
      const artifact = await provider.exportArtifact(handle, "notes/report.txt");
      expect(artifact.name).toBe("report.txt");
      expect(new TextDecoder().decode(artifact.data)).toBe("bytes");
      await expect(provider.getFile(handle, "notes/missing.txt")).rejects.toMatchObject({
        code: "not_found",
      });
      await provider.stop(handle);
      await expect(provider.getFile(handle, "notes/report.txt")).rejects.toMatchObject({
        code: "gone",
      });
      const events = [];
      for await (const event of provider.exec(handle, { argv: ["echo", "hi"] })) events.push(event);
      expect(events).toEqual([expect.objectContaining({ type: "error", code: "gone" })]);
      await provider.destroy(handle);
      await provider.destroy(handle); // idempotent
      await expect(provider.destroy(unknownHandle())).rejects.toMatchObject({ code: "not_found" });
      expect(await provider.list()).toEqual([]);
    } finally {
      await sshd.stop();
    }
  }, 120_000);

  it("rediscovers computers after a control-plane restart", async () => {
    const sshd = await startSshd();
    try {
      const first = createSshVmProvider(sshd.entry, async () => sshd.privateKey);
      const handle = await first.create(createComputerSpec({ profile: "persistent" }));
      // A new provider instance shares no process state, only the VM's metadata.
      const second = createSshVmProvider(sshd.entry, async () => sshd.privateKey);
      const listed = await second.list();
      expect(listed.map((entry) => entry.providerComputerId)).toContain(handle.providerComputerId);
      const events = [];
      for await (const event of second.exec(handle, { argv: ["echo", "back"] })) events.push(event);
      expect(events).toEqual([
        { type: "stdout", text: "back\n" },
        { type: "exit", code: 0 },
      ]);
      await second.destroy(handle);
      expect(await second.list()).toEqual([]);
    } finally {
      await sshd.stop();
    }
  }, 120_000);

  it("keeps the private key off the guest (key canary, AC1)", async () => {
    const sshd = await startSshd();
    try {
      const provider = createSshVmProvider(sshd.entry, async () => sshd.privateKey);
      const handle = await provider.create(createComputerSpec({ profile: "standard" }));
      await provider.putFile(handle, "data.txt", new TextEncoder().encode("payload"));
      for await (const _event of provider.exec(handle, { argv: ["cat", "data.txt"] })) {
        // drain
      }
      await provider.destroy(handle);
      // The workspace is gone with destroy; the canary scans the base dir for strays.
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const full = join(dir, entry.name);
          return entry.isDirectory() ? walk(full) : [full];
        });
      const strays = existsSync(sshd.baseDir) ? walk(sshd.baseDir) : [];
      for (const file of strays) {
        if (statSync(file).size > 1_000_000) continue;
        expect(readFileSync(file, "utf8")).not.toContain(sshd.privateKey);
      }
    } finally {
      await sshd.stop();
    }
  }, 120_000);
});
