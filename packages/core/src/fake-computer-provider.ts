// SPDX-License-Identifier: Apache-2.0
// In-memory reference double for the `ComputerProvider` port (M4-01 AC4). Map-backed computers
// and files, scripted exec. This is a TEST AND REFERENCE DOUBLE ONLY: it holds bytes in process
// memory, enforces nothing, and never stands in for a real adapter outside tests. It is the
// executable spec the conformance suite runs against in CI now, and the stub M4-07 AC10 needs
// later. Calling a surface the declared capabilities say is absent rejects with `unsupported`.

import {
  assertComputerSpec,
  type ComputerCapabilities,
  type ComputerHandle,
  type ComputerProfile,
  type ComputerProvider,
  ComputerProviderError,
  type ComputerState,
  type ComputerSurfaces,
  type CredentialDelivery,
  type EgressControl,
  type ExecEvent,
  type ExecRequest,
} from "./computer-provider";

const ALL_PROFILES: ComputerProfile[] = [
  "standard",
  "persistent",
  "authenticated_browser",
  "subscription_cli",
];

/** Knobs for the fake: which declarations it reports and which surfaces it honours. */
export interface FakeComputerProviderOptions {
  id?: string;
  credentialDelivery?: CredentialDelivery;
  egressControl?: EgressControl;
  profiles?: ComputerProfile[];
  persistentDisk?: boolean;
  /** Absent flags default to execStream/files on, browser/desktop/snapshot/preview off. */
  surfaces?: Partial<ComputerSurfaces>;
}

interface FakeComputer {
  handle: ComputerHandle;
  files: Map<string, Uint8Array>;
}

function unsupported(providerId: string, surface: string): ComputerProviderError {
  return new ComputerProviderError(
    `provider "${providerId}" does not offer the ${surface} surface`,
    "unsupported",
  );
}

/**
 * Creates an isolated in-memory provider (M4-01 AC4). Each call gets its own computer and file
 * maps; nothing is shared between instances. Options override the default declarations, so tests
 * can build a files-less or exec-less fake and assert `unsupported` plus conformance skips.
 */
export function createFakeComputerProvider(
  options: FakeComputerProviderOptions = {},
): ComputerProvider {
  const id = options.id ?? "fake";
  const capabilities: ComputerCapabilities = {
    credentialDelivery: options.credentialDelivery ?? "proxy-token",
    egressControl: options.egressControl ?? "none",
    profiles: options.profiles ?? [...ALL_PROFILES],
    persistentDisk: options.persistentDisk ?? false,
    surfaces: {
      execStream: true,
      files: true,
      browser: false,
      desktop: false,
      snapshot: false,
      preview: false,
      ...options.surfaces,
    },
  };

  let counter = 0;
  const computers = new Map<string, FakeComputer>();

  const snapshot = (computer: FakeComputer): ComputerHandle => ({ ...computer.handle });

  /** Live computer or throw: never-seen ids are `not_found`, destroyed ones are `gone`. */
  const live = (handle: ComputerHandle): FakeComputer => {
    const computer = computers.get(handle.providerComputerId);
    if (!computer) {
      throw new ComputerProviderError(
        `unknown computer "${handle.providerComputerId}"`,
        "not_found",
      );
    }
    if (computer.handle.state === "destroyed") {
      throw new ComputerProviderError(
        `computer "${handle.providerComputerId}" is destroyed`,
        "gone",
      );
    }
    return computer;
  };

  const setState = (computer: FakeComputer, state: ComputerState): void => {
    computer.handle = { ...computer.handle, state };
  };

  return {
    id,
    async create(spec): Promise<ComputerHandle> {
      // Re-checks the raw object first: a hand-rolled spec without the timeouts fails (AC2).
      assertComputerSpec(spec);
      counter += 1;
      const createdAt = new Date();
      const handle: ComputerHandle = {
        providerId: id,
        providerComputerId: `${id}-${counter}`,
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
      computers.set(handle.providerComputerId, { handle, files: new Map() });
      return snapshot(computers.get(handle.providerComputerId) as FakeComputer);
    },
    exec(handle: ComputerHandle, request: ExecRequest): AsyncIterable<ExecEvent> {
      if (!capabilities.surfaces.execStream) throw unsupported(id, "exec stream");
      const computer = live(handle);
      if (computer.handle.state !== "running") {
        throw new ComputerProviderError(
          `computer "${handle.providerComputerId}" is ${computer.handle.state}`,
          "gone",
        );
      }
      if (!Array.isArray(request.argv) || request.argv.length === 0) {
        throw new ComputerProviderError("exec argv must be a non-empty array", "invalid_spec");
      }
      const argv = [...request.argv];
      const stdin = request.stdin;
      const signal = request.signal;
      return (async function* (): AsyncGenerator<ExecEvent> {
        if (signal?.aborted) {
          yield { type: "error", code: "aborted", message: "exec aborted" };
          return;
        }
        // Scripted output: stdin first (when the caller piped one in), then the joined argv.
        if (stdin !== undefined) yield { type: "stdout", text: stdin };
        yield { type: "stdout", text: argv.join(" ") };
        if (signal?.aborted) {
          yield { type: "error", code: "aborted", message: "exec aborted" };
          return;
        }
        if (argv[0] === "fail") {
          yield { type: "stderr", text: "fake failure" };
          yield { type: "exit", code: 1 };
          return;
        }
        yield { type: "exit", code: 0 };
      })();
    },
    async putFile(handle: ComputerHandle, path: string, data: Uint8Array): Promise<void> {
      if (!capabilities.surfaces.files) throw unsupported(id, "files");
      const computer = live(handle);
      if (computer.handle.state !== "running") {
        throw new ComputerProviderError(
          `computer "${handle.providerComputerId}" is ${computer.handle.state}`,
          "gone",
        );
      }
      if (typeof path !== "string" || path.length === 0) {
        throw new ComputerProviderError("file path must be a non-empty string", "invalid_spec");
      }
      computer.files.set(path, new Uint8Array(data));
    },
    async getFile(handle: ComputerHandle, path: string): Promise<Uint8Array> {
      if (!capabilities.surfaces.files) throw unsupported(id, "files");
      const computer = live(handle);
      const data = computer.files.get(path);
      if (!data) {
        throw new ComputerProviderError(`file "${path}" not found`, "not_found");
      }
      return new Uint8Array(data);
    },
    async exportArtifact(
      handle: ComputerHandle,
      path: string,
    ): Promise<{ name: string; data: Uint8Array }> {
      if (!capabilities.surfaces.files) throw unsupported(id, "files");
      // Artifact export is the pull-into-Outputs path: same bytes as the file, display name only.
      const data = await this.getFile(handle, path);
      const name = path.split("/").pop() ?? path;
      return { name, data };
    },
    async stop(handle: ComputerHandle): Promise<void> {
      const computer = live(handle);
      if (computer.handle.state === "running") setState(computer, "stopped");
    },
    async destroy(handle: ComputerHandle): Promise<void> {
      const computer = computers.get(handle.providerComputerId);
      if (!computer) {
        throw new ComputerProviderError(
          `unknown computer "${handle.providerComputerId}"`,
          "not_found",
        );
      }
      if (computer.handle.state === "destroyed") return; // idempotent
      setState(computer, "destroyed");
      computer.files.clear();
    },
    async list(): Promise<ComputerHandle[]> {
      return [...computers.values()]
        .filter((computer) => computer.handle.state !== "destroyed")
        .map(snapshot);
    },
    capabilities(): ComputerCapabilities {
      return {
        ...capabilities,
        profiles: [...capabilities.profiles],
        surfaces: { ...capabilities.surfaces },
      };
    },
  };
}
