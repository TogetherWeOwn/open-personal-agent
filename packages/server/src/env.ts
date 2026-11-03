// SPDX-License-Identifier: Apache-2.0
// The app's ports (ADR 0011 #4): the bindings it reads, as the structural shapes it uses. Each
// composition root satisfies them with its own adapters (Cloudflare's bindings in apps/worker,
// SQLite and the file system in apps/node), so no Cloudflare type is named here.
import type { DataBindings, UserScope } from "@opa/db/repository";
import type { systemStore } from "@opa/db/system";
import type { WorkersAIBinding } from "@opa/providers";
import type { Vault } from "@opa/vault";
import type { ComputerDriver } from "./computer-driver";

/** The user's assistant as the app reaches it: `/api/health` pings one. */
export interface AssistantStub {
  ping(): Promise<string> | string;
}

/** The database, files and assistants, as the repository and the system store read them. */
type DataPorts = DataBindings<AssistantStub, unknown> & Parameters<typeof systemStore>[0];

/**
 * The bindings the app reads, without the master keys: only the composition root (`compose.ts`)
 * sees those (ADR 0010 D4.1 #1).
 */
export interface AppPorts extends DataPorts {
  /** The SPA's static assets. */
  ASSETS: { fetch(request: Request): Response | Promise<Response> };
  /** Workers AI. Absent where the runtime has none; health reports it by presence only. */
  AI?: WorkersAIBinding;
  /**
   * Browser Rendering (the `browser` tool, Workers only). Opaque here: only the Worker's
   * session adapter speaks to it. Absent, the tool is not offered — the Node root has none.
   */
  BROWSER?: unknown;
  /**
   * Background task runs. Health reports it by presence only, so it never creates one.
   * The Tasks cancel route terminates the run's instance through `get`; a root without the
   * binding (apps/node) leaves it absent and the cancel is row-only.
   */
  TASK_WORKFLOW?: {
    create(...args: never[]): Promise<unknown>;
    get(id: string): Promise<{ terminate(): Promise<void> }>;
  };
  /**
   * Data export runs (M3-20 AC1). The export route creates instances; health reports the
   * binding by presence only, so it never creates one. Account deletion terminates a running
   * export's instance through `get` where the runtime offers it (Workers); elsewhere the
   * failed row alone stops the run.
   */
  EXPORT_WORKFLOW?: {
    create(instance: { id: string; params?: unknown }): Promise<unknown>;
    get?(id: string): Promise<{ terminate(): Promise<void> }>;
  };
  OPA_SESSION_SECRET?: string | undefined;
  OPA_SETUP_TOKEN?: string | undefined;
  /** The per-file attachment cap in bytes (M3-10 AC1); unset means the 10 MB default. */
  OPA_ATTACHMENT_MAX_BYTES?: string | undefined;
  /**
   * The fetch for model-provider calls. Node's composition root sets an SSRF-guarded one
   * (ADR 0010 D8); on Workers it is unset and the runtime's fetch, which can't reach a private
   * network, is used.
   */
  MODEL_FETCH?: typeof fetch;
  /**
   * Set by Node's composition root when the operator allows private model hosts
   * (`OPA_ALLOW_PRIVATE_MODEL_HOSTS=1`). A base URL may then use plain HTTP to any host, and
   * `MODEL_FETCH` refuses plain HTTP to a public address. Otherwise only loopback may use HTTP.
   */
  MODEL_PRIVATE_HOSTS?: boolean;
  /**
   * The deployment's own hostnames, comma-separated (e.g. `agent.example,www.example.com`),
   * as a manual override or addition. `web_fetch` refuses them, plus the serving hostnames
   * the Worker records itself (workers.dev, custom domains), so a page can't make the turn
   * read the app itself; localhost, private literals and what the fetch port refuses are
   * refused regardless. Unset means only the recorded hostnames apply. Node's root derives
   * this from its public origin instead and ignores the recorded set.
   */
  OPA_OWN_HOSTS?: string;
  /**
   * Set by a composition root whose runtime lacks these (the Node root, for now). Health reports
   * them as false without degrading.
   */
  UNAVAILABLE?: readonly ("workflow" | "ai")[];
  /**
   * The header that carries the client's address, set by a proxy you trust. Defaults to
   * `CF-Connecting-IP`, which only Cloudflare sets; elsewhere a client can send it themselves, so
   * the Node root defaults to a header it fills from the socket.
   */
  OPA_CLIENT_IP_HEADER?: string;
  /**
   * The computer driver, when a composition root configures a provider (M4-04/M4-05). The
   * reconciler sweep and account deletion destroy through it; absent means the provider
   * legs are skipped (rows alone still enforce the deadlines). Set by Node's root for
   * `docker-local`; the Worker sets it for the Cloudflare Sandbox adapter (M4-04).
   */
  COMPUTER_DRIVER?: ComputerDriver;
  /**
   * The per-address limit on the routes that answer without a session (`rate-limit.ts`). The
   * Worker's is `ratelimits` in wrangler.jsonc; the Node root passes one in memory.
   */
  PUBLIC_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** What `compose` adds. `VAULT` is `null` unless `VAULT_STATUS` is `ok`. */
export interface VaultPorts {
  VAULT: Vault | null;
  VAULT_STATUS: "ok" | "key_invalid" | "previous_key_invalid";
}

/** What the HTTP app sees: a root's ports plus the vault. */
export type Env<P extends AppPorts = AppPorts> = P & VaultPorts;

export interface Session {
  /** The `sessions` row ID, never the cookie value. */
  id: string;
  userId: string;
  /** For the scoped repository (ADR 0010 D3). */
  scope: UserScope;
  /** When this session last confirmed a passkey (`POST /api/auth/step-up/session`), or `null`. */
  stepUpAt: number | null;
}

/** Hono's environment for the app: bindings, plus the session the guard resolved. */
export interface AppEnv<P extends AppPorts = AppPorts> {
  Bindings: Env<P>;
  Variables: { session: Session };
}
