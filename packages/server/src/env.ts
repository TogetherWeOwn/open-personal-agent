// SPDX-License-Identifier: Apache-2.0
// The app's ports (ADR 0011 #4): the bindings it reads, as the structural shapes it uses. Each
// composition root satisfies them with its own adapters (Cloudflare's bindings in apps/worker,
// SQLite and the file system in apps/node), so no Cloudflare type is named here.
import type { DataBindings, UserScope } from "@opa/db/repository";
import type { systemStore } from "@opa/db/system";
import type { WorkersAIBinding } from "@opa/providers";
import type { Vault } from "@opa/vault";

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
  /** Background task runs. Health reports it by presence only, so it never creates one. */
  TASK_WORKFLOW?: { create(...args: never[]): Promise<unknown> };
  /**
   * Data export runs (M3-20 AC1). The export route creates instances; health reports the
   * binding by presence only, so it never creates one.
   */
  EXPORT_WORKFLOW?: { create(instance: { id: string; params?: unknown }): Promise<unknown> };
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
