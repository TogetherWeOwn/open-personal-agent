// SPDX-License-Identifier: Apache-2.0
// The `ComputerProvider` port (M4-01, ADR 0007 #1–#2): the seam every computer runs behind.
// Wire adapters (M4-04 Cloudflare Sandbox, M4-05 docker-local) implement this interface; everything
// above them — the lifecycle owner record (M4-02), computer tools (M4-07), Settings (M4-10) — sees
// only these types. Like `model-provider.ts`, this module is runtime-agnostic: pure types plus
// small runtime validators, so the ports lint covers it with no new rule.

/** Machine-readable failure modes for computer operations (M4-01). */
export type ComputerProviderErrorCode =
  | "not_found"
  | "gone"
  | "unsupported"
  | "invalid_spec"
  | "provider"
  | "aborted";

/**
 * Every computer failure reports with this. Pre-stream validation and lifecycle failures
 * (unknown or stopped/destroyed computer, undeclared surface, malformed spec/argv) throw
 * synchronously before `exec` returns its iterable; failures after the stream starts terminate
 * it with an `{type: "error"}` event instead. `not_found` names a
 * computer id the provider has never seen; `gone` names one it destroyed or stopped out from
 * under the caller. `unsupported` names a surface the provider's capabilities declare absent.
 * `invalid_spec` names a malformed `ComputerSpec`. `provider` names an adapter-side failure.
 * `aborted` names a caller-cancelled exec (`ExecRequest.signal`), delivered as a terminal
 * stream event.
 */
export class ComputerProviderError extends Error {
  readonly code: ComputerProviderErrorCode;

  constructor(message: string, code: ComputerProviderErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComputerProviderError";
    this.code = code;
  }
}

/** Which computer shape a task gets (ADR 0007 #2). */
export type ComputerProfile =
  | "standard"
  | "persistent"
  | "authenticated_browser"
  | "subscription_cli";

/**
 * How model-call credentials reach the computer (ADR 0007 #2). This is a provider *declaration*
 * here, not a delivery: no token is minted or placed by anything in this module.
 */
export type CredentialDelivery = "egress-inject" | "proxy-token";

/** How much network the provider can actually enforce (ADR 0007 #2). */
export type EgressControl = "allowlist" | "on-off" | "none";

const COMPUTER_PROFILES: readonly ComputerProfile[] = [
  "standard",
  "persistent",
  "authenticated_browser",
  "subscription_cli",
];

const CREDENTIAL_DELIVERIES: readonly CredentialDelivery[] = ["egress-inject", "proxy-token"];

const EGRESS_CONTROLS: readonly EgressControl[] = ["allowlist", "on-off", "none"];

/** Idle-stop default (M4-01 AC2): a computer idles out after 5 minutes. */
const DEFAULT_IDLE_TIMEOUT_SECONDS = 300;

/** Max-lifetime default (M4-01 AC2): a computer lives at most one hour. */
const DEFAULT_MAX_LIFETIME_SECONDS = 3600;

/**
 * Timeout ceiling (M4-01): one year in seconds. `assertComputerSpec` rejects larger values so
 * deadline arithmetic (`createdAt + timeout * 1000`) stays inside the `Date` range and every
 * failure reports as `invalid_spec` instead of escaping as a `RangeError`.
 */
const MAX_TIMEOUT_SECONDS = 365 * 24 * 3600;

function isComputerProfile(value: unknown): value is ComputerProfile {
  return typeof value === "string" && (COMPUTER_PROFILES as readonly string[]).includes(value);
}

function invalidSpec(message: string): ComputerProviderError {
  return new ComputerProviderError(`invalid computer spec: ${message}`, "invalid_spec");
}

/**
 * What a computer is booted with (M4-01 AC2). `idleTimeoutSeconds` and `maxLifetimeSeconds` are
 * required on a constructed spec: build it with `createComputerSpec`, which applies the idle-300 /
 * lifetime-3600 defaults. A hand-rolled object literal without the two fields fails
 * `assertComputerSpec`, and `create()` implementations call that first.
 */
export interface ComputerSpec {
  profile: ComputerProfile;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  /** Provider size name (M4-04 default `standard-1`). */
  sizeId?: string;
  /** Requested egress allowlist; honoured only where `egressControl` is `"allowlist"`. */
  egressHosts?: string[];
}

/**
 * The only blessed construction path (M4-01 AC2): applies the defaults, then validates — finite
 * integers, both > 0, idle ≤ lifetime — throwing `invalid_spec` on violation.
 */
export function createComputerSpec(
  input: Partial<ComputerSpec> & Pick<ComputerSpec, "profile">,
): ComputerSpec {
  if (typeof input !== "object" || input === null) {
    throw invalidSpec("spec must be an object");
  }
  const spec: ComputerSpec = {
    profile: input.profile,
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
    maxLifetimeSeconds: input.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS,
  };
  if (input.sizeId !== undefined) spec.sizeId = input.sizeId;
  if (input.egressHosts !== undefined) spec.egressHosts = input.egressHosts;
  assertComputerSpec(spec);
  return spec;
}

/**
 * Re-checks a raw object (M4-01 AC2): missing timeouts fail, so a hand-rolled spec without the
 * two fields cannot construct a computer. `create()` implementations call this first.
 */
export function assertComputerSpec(spec: unknown): asserts spec is ComputerSpec {
  if (typeof spec !== "object" || spec === null) {
    throw invalidSpec("spec must be an object");
  }
  const candidate = spec as Partial<ComputerSpec>;
  if (!isComputerProfile(candidate.profile)) {
    throw invalidSpec(`profile must be one of ${COMPUTER_PROFILES.join(", ")}`);
  }
  for (const field of ["idleTimeoutSeconds", "maxLifetimeSeconds"] as const) {
    const value = candidate[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw invalidSpec(`${field} must be a finite integer`);
    }
    if (value <= 0 || value > MAX_TIMEOUT_SECONDS) {
      throw invalidSpec(`${field} must be > 0 and ≤ ${MAX_TIMEOUT_SECONDS}`);
    }
  }
  const idle = candidate.idleTimeoutSeconds as number;
  const lifetime = candidate.maxLifetimeSeconds as number;
  if (idle > lifetime) {
    throw invalidSpec("idleTimeoutSeconds must be ≤ maxLifetimeSeconds");
  }
  if (
    candidate.sizeId !== undefined &&
    (typeof candidate.sizeId !== "string" || candidate.sizeId.length === 0)
  ) {
    throw invalidSpec("sizeId must be a non-empty string when present");
  }
  if (candidate.egressHosts !== undefined) {
    if (
      !Array.isArray(candidate.egressHosts) ||
      candidate.egressHosts.some((host) => typeof host !== "string" || host.length === 0)
    ) {
      throw invalidSpec("egressHosts must be an array of non-empty strings when present");
    }
  }
}

/** Lifecycle state of one computer (M4-01). */
export type ComputerState = "running" | "stopped" | "destroyed";

/**
 * One computer, as the provider reports it. `providerComputerId` is an opaque handle field only —
 * never identity or authorization (that is the M4-02 owner record's job). The deadlines are
 * computed from the spec at `create()` and echoed on `list()` entries, which is what the M4-02
 * sweep consumes.
 */
export interface ComputerHandle {
  providerId: string;
  providerComputerId: string;
  profile: ComputerProfile;
  state: ComputerState;
  createdAt: string;
  idleDeadlineAt: string;
  lifetimeDeadlineAt: string;
}

/**
 * What `exec` runs (M4-01). `argv` is never a shell string, and `stdin` rides separately: token
 * delivery later goes via exec stdin / a provider file write, never a command line (M4-00a AC1c,
 * M4-04 AC7), so the plumbing is pinned now.
 */
export interface ExecRequest {
  argv: string[];
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/**
 * Normalized exec stream events, mirroring the `ModelEvent` contract: zero or more output events,
 * then exactly one terminal event — `{type: "exit", code}` for a finished command, or
 * `{type: "error", code, message}` for one that never completed. The `error` codes are the
 * `ComputerProviderErrorCode`s.
 */
export type ExecEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number }
  | { type: "error"; code: ComputerProviderErrorCode; message: string };

/** Optional surfaces a provider may or may not offer (M4-01 AC1, A-C3). */
export interface ComputerSurfaces {
  execStream: boolean;
  files: boolean;
  browser: boolean;
  desktop: boolean;
  snapshot: boolean;
  preview: boolean;
}

const SURFACE_KEYS: readonly (keyof ComputerSurfaces)[] = [
  "execStream",
  "files",
  "browser",
  "desktop",
  "snapshot",
  "preview",
];

/**
 * What a provider declares (M4-01 AC1/AC3). Every field is required. The ADR 0007 #2 declarations
 * (`credentialDelivery`, `egressControl`, `profiles`, `persistentDisk`) decide where profiles are
 * offered (M4-13/14); every optional surface is gated by its flag, and callers (and later the UI)
 * must check before use — never assume one.
 */
export interface ComputerCapabilities {
  credentialDelivery: CredentialDelivery;
  egressControl: EgressControl;
  profiles: ComputerProfile[];
  persistentDisk: boolean;
  surfaces: ComputerSurfaces;
}

/**
 * Re-checks a provider declaration (M4-01 AC3). Registration calls this and throws when any ADR
 * 0007 #2 field is missing or invalid — a runtime check, since TS types alone do not stop a JS
 * adapter from registering a malformed declaration.
 */
export function assertComputerCapabilities(
  capabilities: unknown,
): asserts capabilities is ComputerCapabilities {
  const fail = (message: string): never => {
    throw new ComputerProviderError(`invalid computer capabilities: ${message}`, "provider");
  };
  if (typeof capabilities !== "object" || capabilities === null) {
    fail("capabilities must be an object");
  }
  const candidate = capabilities as Partial<ComputerCapabilities>;
  if (
    typeof candidate.credentialDelivery !== "string" ||
    !(CREDENTIAL_DELIVERIES as readonly string[]).includes(candidate.credentialDelivery)
  ) {
    fail(`credentialDelivery must be one of ${CREDENTIAL_DELIVERIES.join(", ")}`);
  }
  if (
    typeof candidate.egressControl !== "string" ||
    !(EGRESS_CONTROLS as readonly string[]).includes(candidate.egressControl)
  ) {
    fail(`egressControl must be one of ${EGRESS_CONTROLS.join(", ")}`);
  }
  if (
    !Array.isArray(candidate.profiles) ||
    candidate.profiles.length === 0 ||
    candidate.profiles.some((profile) => !isComputerProfile(profile))
  ) {
    fail(`profiles must be a non-empty array of ${COMPUTER_PROFILES.join(", ")}`);
  }
  if (typeof candidate.persistentDisk !== "boolean") {
    fail("persistentDisk must be a boolean");
  }
  if (typeof candidate.surfaces !== "object" || candidate.surfaces === null) {
    fail("surfaces must be an object with a boolean per surface");
  }
  for (const key of SURFACE_KEYS) {
    if (typeof (candidate.surfaces as Partial<ComputerSurfaces>)[key] !== "boolean") {
      fail(`surfaces.${key} must be a boolean`);
    }
  }
}

/**
 * The computer port (M4-01 AC1): create, streaming exec, file put/get, artifact export (the
 * pull-into-Outputs path — distinct from file get), `stop`, idempotent `destroy`, `list`, and
 * `capabilities()`. `create()` implementations call `assertComputerSpec` first; calling a surface
 * the capabilities declare absent rejects with `unsupported`.
 */
export interface ComputerProvider {
  /** Stable provider id, mirroring `ModelProvider.id`. */
  readonly id: string;
  create(spec: ComputerSpec): Promise<ComputerHandle>;
  /**
   * May throw synchronously for validation, lifecycle, or unsupported-surface failures
   * (before the iterable is returned). Failures after iteration starts are terminal
   * `{type: "error"}` events, never a second throw.
   */
  exec(handle: ComputerHandle, request: ExecRequest): AsyncIterable<ExecEvent>;
  putFile(handle: ComputerHandle, path: string, data: Uint8Array): Promise<void>;
  getFile(handle: ComputerHandle, path: string): Promise<Uint8Array>;
  /** Pulls a file from the computer into Outputs; `name` is display metadata only. */
  exportArtifact(handle: ComputerHandle, path: string): Promise<{ name: string; data: Uint8Array }>;
  stop(handle: ComputerHandle): Promise<void>;
  /** Idempotent: destroying a destroyed computer succeeds. */
  destroy(handle: ComputerHandle): Promise<void>;
  list(): Promise<ComputerHandle[]>;
  capabilities(): ComputerCapabilities;
}

/** The provider set one host runs with, and the default M4-10 Settings will persist (M4-01 AC5). */
export interface ComputerProviderRegistry {
  readonly providers: readonly ComputerProvider[];
  get(id: string): ComputerProvider;
  /**
   * Resolves the `defaultProviderId` settings value to a provider. Throws naming the unknown id;
   * with no settings value, falls back to the sole registered provider only when exactly one
   * exists — ambiguity never silently picks.
   */
  resolveDefault(defaultProviderId?: string): ComputerProvider;
}

/**
 * Builds the registry (M4-01 AC3 + AC5): calls `capabilities()` on each provider at registration
 * and throws when any ADR 0007 #2 declaration is missing/invalid or two providers share an id.
 * Switching the default provider is a settings-value change only — the same registry resolves a
 * different provider when the value changes; no other state, no data moved. Real settings
 * persistence/UI is M4-10; this is the pure resolution seam it will write to.
 */
export function createComputerProviderRegistry(
  providers: ComputerProvider[],
): ComputerProviderRegistry {
  if (!Array.isArray(providers)) {
    throw new ComputerProviderError(
      "invalid computer registry: providers must be an array",
      "provider",
    );
  }
  const byId = new Map<string, ComputerProvider>();
  for (const provider of providers) {
    if (typeof provider !== "object" || provider === null) {
      throw new ComputerProviderError(
        "invalid computer registry: provider must be an object",
        "provider",
      );
    }
    if (typeof provider.id !== "string" || provider.id.length === 0) {
      throw new ComputerProviderError(
        "invalid computer registry: provider id must be a non-empty string",
        "provider",
      );
    }
    if (byId.has(provider.id)) {
      throw new ComputerProviderError(
        `invalid computer registry: duplicate provider id "${provider.id}"`,
        "provider",
      );
    }
    let capabilities: ComputerCapabilities;
    try {
      capabilities = provider.capabilities();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ComputerProviderError(
        `invalid computer registry: provider "${provider.id}" capabilities() threw: ${detail}`,
        "provider",
      );
    }
    try {
      assertComputerCapabilities(capabilities);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ComputerProviderError(
        `invalid computer registry: provider "${provider.id}" declares ${detail}`,
        "provider",
      );
    }
    byId.set(provider.id, provider);
  }
  const list = [...byId.values()];
  const get = (id: string): ComputerProvider => {
    const provider = byId.get(id);
    if (!provider) {
      throw new ComputerProviderError(
        `unknown computer provider "${id}" (known: ${list.map((p) => p.id).join(", ") || "none"})`,
        "not_found",
      );
    }
    return provider;
  };
  return {
    providers: list,
    get,
    resolveDefault(defaultProviderId?: string): ComputerProvider {
      if (defaultProviderId === undefined) {
        if (list.length === 1 && list[0] !== undefined) return list[0];
        throw new ComputerProviderError(
          "invalid computer registry: no default provider set and " +
            (list.length === 0
              ? "no providers are registered"
              : "more than one provider is registered"),
          "provider",
        );
      }
      return get(defaultProviderId);
    },
  };
}
