// SPDX-License-Identifier: Apache-2.0
// The ssh-vm provider entry (M4-06, F-4.3, ADR 0007 #4): the user-supplied VM a `ComputerProvider`
// runs the shared image over, reached over SSH. This module is runtime-agnostic — pure types plus
// small validators, like `computer-provider.ts` — so the Node adapter (`apps/node`) and the future
// Settings persistence (M4-10) share it without pulling an SSH client into the Worker bundle.
//
// The SSH credential itself is a vault secret (`ssh_private_key` purpose) whose AAD `binding` is
// the `sshCredentialBinding` of the entry below: a key saved for one entry (or one VM) never
// decrypts for another, the same domain separation model credentials get from
// `credentialBinding` (ADR 0006 #5). The control plane decrypts it per connection and passes the
// key material only to the SSH client auth packet — never into the computer (no env var, file,
// command line, URL or log), never to disk, and never through the M4-02 lifecycle record.

import {
  assertComputerCapabilities,
  type ComputerCapabilities,
  type ComputerProfile,
} from "./computer-provider";

/** The stable provider id M4-10 Settings and the M4-02 owner record name this adapter by. */
export const SSH_VM_PROVIDER_ID = "ssh-vm";

/**
 * Guest contract: what the user-supplied VM must offer for the adapter to work. The shared OCI
 * image (M4-04 AC5) defines the full userland when it lands; until then the adapter probes this
 * documented minimum at `create()` and fails closed naming the gap: a POSIX `sh`, `mkdir`,
 * `rm`, `cat` and `pwd` on `PATH`, and a writable, persistent `HOME` (the workspace lives under
 * it, which is what `persistentDisk: true` means here — the VM's disk, not an image layer).
 */
export const SSH_VM_GUEST_CONTRACT = ["sh", "mkdir", "rm", "cat", "pwd"] as const;

const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HOST_PIN = /^SHA256:[A-Za-z0-9+/]+={0,2}$/;

/**
 * One ssh-vm target (M4-06 AC1): the user-supplied VM plus the pins that make SSH to it safe.
 * `credentialSecretId` names the vault secret holding the OpenSSH-format private key; the binding
 * in that secret's AAD must equal `sshCredentialBinding(entry)`. `hostKeyPins` pins the VM's
 * host key (OpenSSH `SHA256:` fingerprints, as `ssh-keyscan` prints): the adapter connects only
 * to a server presenting a pinned key, never trust-on-first-use. `baseDir` overrides the
 * workspace parent (default `<HOME>/.opa/computers`).
 */
export interface SshVmProviderEntry {
  id: string;
  host: string;
  port?: number;
  username: string;
  hostKeyPins: string[];
  credentialSecretId: string;
  baseDir?: string;
}

/** The SSH default port, applied when the entry leaves `port` unset. */
export const SSH_VM_DEFAULT_PORT = 22;

function entryError(message: string): Error {
  return new Error(`invalid ssh-vm provider entry: ${message}`);
}

/**
 * Re-checks a provider entry (M4-06 AC1). Every field that lands in the credential binding
 * (`id`, `host`, `port`, `username`) rejects the AAD separator `|`, so two entries can never
 * share a binding and a binding never parses ambiguously. Host keys must be pinned — an empty
 * pin list fails — because auto-trusting a user-supplied VM's key would trade MITM for setup
 * convenience.
 */
export function assertSshVmEntry(entry: unknown): asserts entry is SshVmProviderEntry {
  if (typeof entry !== "object" || entry === null) {
    throw entryError("entry must be an object");
  }
  const candidate = entry as Partial<SshVmProviderEntry>;
  if (typeof candidate.id !== "string" || !ENTRY_ID.test(candidate.id)) {
    throw entryError(
      "id must be 1-63 lowercase alphanumeric-or-dash characters starting with an alphanumeric",
    );
  }
  if (
    typeof candidate.host !== "string" ||
    candidate.host.length === 0 ||
    candidate.host.length > 253 ||
    /[\s|@]/.test(candidate.host)
  ) {
    throw entryError("host must be a non-empty hostname or IP without whitespace, | or @");
  }
  if (candidate.port !== undefined) {
    if (!Number.isSafeInteger(candidate.port) || candidate.port < 1 || candidate.port > 65535) {
      throw entryError("port must be an integer 1-65535 when present");
    }
  }
  if (
    typeof candidate.username !== "string" ||
    candidate.username.length === 0 ||
    /[\s|:]/.test(candidate.username)
  ) {
    throw entryError("username must be non-empty without whitespace, | or :");
  }
  if (
    !Array.isArray(candidate.hostKeyPins) ||
    candidate.hostKeyPins.length === 0 ||
    candidate.hostKeyPins.some((pin) => typeof pin !== "string" || !HOST_PIN.test(pin))
  ) {
    throw entryError("hostKeyPins must be a non-empty array of SHA256:<base64> pins");
  }
  if (
    typeof candidate.credentialSecretId !== "string" ||
    candidate.credentialSecretId.length === 0 ||
    candidate.credentialSecretId.includes("|")
  ) {
    throw entryError("credentialSecretId must be a non-empty string without |");
  }
  if (
    candidate.baseDir !== undefined &&
    (typeof candidate.baseDir !== "string" ||
      candidate.baseDir.length === 0 ||
      candidate.baseDir.includes("\0"))
  ) {
    throw entryError("baseDir must be a non-empty string when present");
  }
}

/**
 * The vault `binding` for this entry's SSH credential (M4-06 AC1): `ssh:<id>|<host>:<port>|<user>`.
 * Host is lowercased (DNS is case-insensitive) and the port always present (default 22 applied),
 * so the same target written two ways binds the same secret, while any entry field, host or user
 * change binds a different one. `|` cannot appear in a field (rejected above), so bindings never
 * collide across shapes.
 */
export function sshCredentialBinding(entry: SshVmProviderEntry): string {
  assertSshVmEntry(entry);
  const port = entry.port ?? SSH_VM_DEFAULT_PORT;
  return `ssh:${entry.id}|${entry.host.toLowerCase()}:${port}|${entry.username}`;
}

/**
 * The honest declaration (M4-06 AC2): `proxy-token` delivery — the control plane holds the SSH
 * key and there is no egress injector on a user-supplied VM; `egressControl: "none"` — the
 * provider cannot enforce network policy on someone else's host, so allowlist-requiring profiles
 * (`authenticated_browser`, `subscription_cli`) are not offered; `persistentDisk: true` — the
 * VM's disk (and the workspace on it) survives restarts; snapshot/preview `false` — shown as
 * unsupported (A-C3), never emulated.
 */
export function sshVmCapabilities(): ComputerCapabilities {
  const capabilities: ComputerCapabilities = {
    credentialDelivery: "proxy-token",
    egressControl: "none",
    profiles: ["standard", "persistent"],
    persistentDisk: true,
    surfaces: {
      execStream: true,
      files: true,
      browser: false,
      desktop: false,
      snapshot: false,
      preview: false,
    },
  };
  assertComputerCapabilities(capabilities);
  return capabilities;
}

/** The profiles this provider offers (M4-06 AC2): the two that need no egress enforcement. */
export const SSH_VM_PROFILES: readonly ComputerProfile[] = ["standard", "persistent"];
