# SSH VM computer provider

`ssh-vm` runs the shared `computers/image` image in Docker on a user-supplied Linux VM,
using SSH only as the control-plane transport. It is an optional second provider, **not
an M4 exit criterion**; it can move to M5 without changing the M4 exit criteria. This
adapter does not provision a VM, install a daemon, or deploy the control plane.

## Integration status

This change supplies the Node-only `ComputerProvider` implementation and conformance
suite, not an enabled application computer path. Neither `createNodeApp` nor the
Worker composition root registers this factory, and there is no Settings switch or
environment variable that enables it. An integrating composition root must bind a
provider entry to its owner's vault scope and bridge the lifecycle `ComputerDriver`
interface; this adapter must not be handed to that interface unchanged. Task tools,
owner authorization, token delivery and lifecycle sweep wiring are not supplied here.
Do not treat standalone provider conformance as an end-to-end application acceptance.

## VM prerequisites

- A reachable OpenSSH server with SFTP, public-key authentication and a writable home
  directory for a dedicated control-plane account.
- A working Docker CLI and daemon accessible to that account, plus POSIX `sh` and `rm`.
  Host commands use only `/usr/bin:/bin`, never account-writable PATH entries; install
  the required tools there. The login shell, system binaries and daemon remain trusted
  administrator-controlled prerequisites. Docker access is host-privileged: use an
  account and VM dedicated to this provider, not a login used inside managed computers.
  This is not a hardened multi-tenant VM.
- The shared image preloaded on that daemon. Build it from this repository's Dockerfile
  and pins; neither `create()` nor `exec()` installs tools, builds, or pulls an image.

From the repository root on the VM, prepare the shared image:

```sh
node --input-type=module <<'JS'
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const pins = JSON.parse(readFileSync('computers/image/pins.json', 'utf8'));
execFileSync('docker', [
  'build', '-f', 'computers/image/Dockerfile',
  '--build-arg', `BASE_DIGEST=${pins.baseDigest}`,
  '--build-arg', `GIT_VERSION=${pins.packages.git}`,
  '-t', `opa-computer:${pins.baseDigest.slice(7, 19)}`, 'computers/image',
], { stdio: 'inherit' });
JS
```

The local tag is a discovery/cache key only. Before allocating a computer, the adapter
resolves it to the local immutable `sha256:` image ID. `docker run` receives that ID and
`--pull=never`, never a floating tag. An optional factory `imageRef` accepts only a
preloaded image ID or registry digest, not a tag. A missing image or unusable daemon
fails closed; it never falls back to executing task code in the VM's login shell.

## Entry and credential boundary

A `SshVmProviderEntry` supplies `id`, `host`, `username`, `hostKeyPins`,
`credentialSecretId`, and optional `port` and `baseDir`. Verify each SHA256 host-key
fingerprint out of band; empty pins and trust-on-first-use are not supported. OpenSSH's
unpadded form and the entry validator's accepted trailing base64 padding compare equally.

Store the private key in the vault with purpose `ssh_private_key` and the exact
`sshCredentialBinding(entry)` AAD binding. `loadSshPrivateKey` decrypts only that purpose
and binding. The composition root supplies the loader to `createSshVmProvider`; it
loads the key per connection and gives it only to SSH authentication. Never place the
key in a URL, environment variable, command, log, container file or mount. The adapter
also never gives computers session cookies, model keys or broader-audience tokens.

Host-only `.computer.json` records live under `baseDir` (default
`<HOME>/.opa/computers`). Only metadata is stored there. Each computer has its own
container and named `/work` volume. Neither the host metadata directory nor the Docker
socket is mounted into the computer. Commands and relative or absolute file paths are
resolved inside the container, running as UID 10000 with dropped capabilities,
`no-new-privileges` and CPU/memory/PID limits. `/work` is the default working directory
and persistent mount, not a file-access sandbox: absolute paths and `..` may address
other files writable by UID 10000 inside that same container. They cannot address the
VM's host filesystem or metadata because those paths are not mounted. Exec already
grants the same guest account access; file operations do not grant a wider host scope.

## Lifecycle and capabilities

- `stop()` stops only the computer's container, not the VM. The named volume remains.
- A control-plane restart rediscovers metadata and retains files on the VM disk.
  `list()` reconciles running records with the current daemon's containers.
- Metadata changes write a sibling temporary file, then publish with OpenSSH's atomic
  POSIX rename extension. Interrupted writes retain the previous valid record. The
  initial stopped record is published before any container or volume is allocated;
  interruption before publication can leave only an unused directory/temporary file.
- Failed metadata writes attempt temporary-file cleanup for at most one second, then
  report the original error even when the closed SFTP channel never calls back. A
  leftover temporary file contains only metadata, never the SSH credential.
- `destroy()` removes the container and named volume, then atomically moves the metadata
  directory into `baseDir/.destroyed/<computer-id>`. That location is the durable
  tombstone: a concurrent stop cannot republish into the removed active directory,
  including from a different provider instance or process. Listing reads only active
  records, not the archived history. Tombstones keep destroy idempotent across restarts
  and distinguish destroyed IDs from never-created IDs; they have no automatic expiry.
  Interrupted resource cleanup or a failed archive move leaves the active recovery
  record for retry. A failed create likewise retains a stopped recovery record if
  resource cleanup cannot finish.
- Exec timeout, AbortSignal cancellation and early iterator return clean up the exec's
  process group without stopping other execs or the computer. This is process cleanup,
  not a security boundary against guest code deliberately creating another session.

Capabilities are intentionally limited: `persistentDisk: true`, `execStream` and files
supported; snapshot, preview, browser and desktop unsupported. `egressControl` is
`none`: non-empty egress allowlists and profiles that require enforced egress are
rejected. No snapshot or preview is silently emulated. VM failure or disk removal is
not a backup or persistence guarantee.

## Verification

Prepare the image above, then run:

```sh
OPA_SSH_VM_TEST_REQUIRED=1 pnpm exec vitest run --project node apps/node/test/computers-ssh.test.ts
```

The suite starts a loopback-only, foreground OpenSSH fixture with temporary test keys.
It exercises the shared ComputerProvider conformance suite in the image, binary and
absolute-path file round trips, non-root execution, key/mount isolation, persistence,
container lifecycle and actual process termination on timeout/abort. In-process SSH
transport tests are not substitutes for image conformance.

Local loopback tests skip when sshd or a usable Docker daemon is absent; a present but
broken sshd or missing image fails. `OPA_SSH_VM_TEST_REQUIRED=1` makes missing runtime
prerequisites fail too. The `selfhost-parity` CI job prepares the image and sets this
flag, so acceptance cannot silently pass by skipping conformance.
