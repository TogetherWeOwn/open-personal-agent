// SPDX-License-Identifier: Apache-2.0
// Activity › Log (M3-19 AC3, m3-ux §3.8): the session's own audit rows from the last 365 days,
// newest first, each with its kind and a plain-language title, filterable by kind and searchable.
// Read-only in M3: standing grants are revoked from Settings › Privacy & security instead.
// Three kinds of row are bookkeeping, not something the user did, and stay out of the view
// (they are still in the data export): each successful key decrypt behind a model call, an
// approved call's claim before it runs, and the passkey options an approval asked for.
import { type ActivityMatch, createRepository } from "@opa/db/repository";
import { AUDIT_DAYS, DAY_MS } from "@opa/db/retention";
import { Hono } from "hono";
import type { AppEnv } from "./env";

export const ACTIVITY_KINDS = [
  "sign_in",
  "passkeys",
  "sessions",
  "secrets",
  "approvals",
  "tools",
  "exports",
  "deletions",
  "settings",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number] | "other";

interface Action {
  kind: ActivityKind;
  title: string;
  /** A refused row's title: every result but a success, or but `error` where `failed` is set. */
  refused?: string;
  /** An `error` row's title, where it isn't a refusal. */
  failed?: string;
}

/** Each audited action's kind and title; a refused or failed row can have its own title. */
const ACTIONS: Record<string, Action> = {
  "auth.login": { kind: "sign_in", title: "Signed in", refused: "A sign-in was refused" },
  "auth.logout": { kind: "sign_in", title: "Signed out" },
  "auth.step_up": {
    kind: "sign_in",
    title: "Confirmed with your passkey",
    refused: "A passkey check failed",
  },
  "recovery.code": {
    kind: "sign_in",
    title: "Signed in with a recovery code",
    refused: "A recovery code was refused",
  },
  "auth.passkey_add": { kind: "passkeys", title: "Added a passkey" },
  "auth.passkey_rename": { kind: "passkeys", title: "Renamed a passkey" },
  "auth.passkey_remove": { kind: "passkeys", title: "Removed a passkey" },
  "auth.recovery_regenerate": { kind: "passkeys", title: "Made new recovery codes" },
  "auth.session_revoke": { kind: "sessions", title: "Signed out a device" },
  "auth.sign_out_everywhere": { kind: "sessions", title: "Signed out everywhere" },
  "vault.encrypt": { kind: "secrets", title: "Saved a key", refused: "Couldn't save a key" },
  "vault.decrypt": {
    kind: "secrets",
    title: "Opened a saved key",
    refused: "A saved key didn't open",
  },
  "vault.rewrap": { kind: "secrets", title: "Re-protected your saved keys" },
  "vault.reset_user": { kind: "secrets", title: "Reset your saved keys" },
  "settings.key_add": { kind: "secrets", title: "Added a model key" },
  "settings.key_replace": { kind: "secrets", title: "Replaced a model key" },
  "settings.key_remove": { kind: "secrets", title: "Removed a model key" },
  "settings.provider": { kind: "settings", title: "Changed a model provider" },
  "settings.provider_remove": { kind: "settings", title: "Removed a model provider" },
  "approval.approve": { kind: "approvals", title: "Approved an action" },
  "approval.deny": { kind: "approvals", title: "Denied an action" },
  "approval.execute": {
    kind: "approvals",
    title: "Ran an approved action",
    // `denied` is the policy re-check refusing it; `error`, a run that failed.
    refused: "Stopped an approved action at the last check",
    failed: "An approved action ran and failed",
  },
  "approval.expire": { kind: "approvals", title: "An approval expired" },
  "approval.expire_all": { kind: "approvals", title: "Expired every waiting approval" },
  "approval.step_up": {
    kind: "approvals",
    title: "Confirmed an approval with your passkey",
    refused: "An approval's passkey check failed",
  },
  "approval.decide": { kind: "approvals", title: "Couldn't record a decision" },
  "policy.grant": { kind: "approvals", title: "Allowed an action from now on" },
  "policy.revoke": { kind: "approvals", title: "Stopped allowing an action" },
  "policy.override": {
    kind: "tools",
    title: "Changed a tool's setting",
    refused: "A tool change was refused",
  },
  "export.start": { kind: "exports", title: "Started an export of your data" },
  "export.download": { kind: "exports", title: "Downloaded an export" },
  "export.memory": { kind: "exports", title: "Downloaded your memory" },
  "memory.forget": { kind: "deletions", title: "Deleted memories" },
  "artifact.delete": { kind: "deletions", title: "Deleted a file" },
  "retention.sweep": {
    kind: "deletions",
    title: "Removed old items, as your retention settings say",
  },
  "settings.profile": { kind: "settings", title: "Changed your profile" },
  "settings.model": { kind: "settings", title: "Changed the chat model" },
  "settings.roles": { kind: "settings", title: "Changed which models do what" },
  "settings.memory": { kind: "settings", title: "Changed memory settings" },
  "settings.spending": { kind: "settings", title: "Changed spending limits" },
  "settings.retention": { kind: "settings", title: "Changed how long things are kept" },
};

const HIDDEN = [
  { action: "vault.decrypt", result: "ok" },
  { action: "approval.claim" },
  { action: "approval.step_up_options" },
] as const;

const PAGE = 50;
const MAX_PAGE = 100;
const MAX_QUERY = 100;

const actionsOf = (kind: ActivityKind) =>
  Object.keys(ACTIONS).filter((a) => ACTIONS[a]?.kind === kind);

const SUCCESS = ["ok", "redeemed"];
type ResultClass = Exclude<ActivityMatch["result"], "any">;

/**
 * The column's type says ok, denied or error, but raw SQL writes others: a redeemed recovery
 * code is its success, and every other result but `ok` is a refusal.
 */
const classOf = (result: string): ResultClass =>
  SUCCESS.includes(result) ? "success" : result === "error" ? "error" : "refused";

/** The title a row with a result of this class shows. */
function titleOf(action: Action, result: ResultClass): string {
  if (result === "success") return action.title;
  if (result === "error" && action.failed) return action.failed;
  return action.refused ?? action.title;
}

/**
 * The actions and result classes whose shown title contains `needle`, so a search for "signed
 * in" finds the logins, and one for "refused" only the rows that read so.
 */
function titleMatches(needle: string): ActivityMatch[] {
  return Object.entries(ACTIONS).flatMap(([action, a]): ActivityMatch[] => {
    const classes = (["success", "error", "refused"] as const).filter((r) =>
      titleOf(a, r).toLowerCase().includes(needle),
    );
    if (classes.length === 3) return [{ action, result: "any" as const }];
    return classes.map((result) => ({ action, result }));
  });
}

/** A row's detail as stored: JSON where it was written as JSON, otherwise the plain string. */
function parsed(detail: string | null): unknown {
  if (detail === null) return null;
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}

export const activityRoutes = new Hono<AppEnv>();

/**
 * `?kind=` one of `ACTIVITY_KINDS` or `other`, `?q=` text, `?before=` the last row ID of the
 * previous page, `?limit=` up to 100. `next` is the ID to pass as `before`, or null at the end.
 */
activityRoutes.get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  const kind = c.req.query("kind");
  if (kind !== undefined && ![...ACTIVITY_KINDS, "other"].includes(kind))
    return c.json({ error: "invalid_kind" }, 400);
  const q = c.req.query("q")?.trim() || undefined;
  if (q !== undefined && q.length > MAX_QUERY) return c.json({ error: "invalid_query" }, 400);
  const beforeParam = c.req.query("before");
  const before = beforeParam === undefined ? undefined : Number(beforeParam);
  if (before !== undefined && !(Number.isSafeInteger(before) && before > 0))
    return c.json({ error: "invalid_cursor" }, 400);
  const limit = Math.min(
    Math.max(Math.trunc(Number(c.req.query("limit") ?? PAGE)) || PAGE, 1),
    MAX_PAGE,
  );
  const needle = q?.toLowerCase();
  const rows = await createRepository(c.env)
    .forUser(c.var.session.scope)
    .audit.page({
      since: Date.now() - AUDIT_DAYS * DAY_MS,
      before,
      // One more than asked, to know whether there is a next page.
      limit: limit + 1,
      actions: kind === undefined || kind === "other" ? undefined : actionsOf(kind as ActivityKind),
      // `other` is every action without a kind of its own.
      otherThan: kind === "other" ? Object.keys(ACTIONS) : undefined,
      text: q,
      textActions: needle ? titleMatches(needle) : undefined,
      hide: HIDDEN,
    });
  const page = rows.slice(0, limit);
  return c.json({
    entries: page.map((r) => {
      const known = ACTIONS[r.action];
      return {
        id: r.id,
        at: r.createdAt,
        kind: known?.kind ?? "other",
        title: known ? titleOf(known, classOf(r.result)) : r.action,
        action: r.action,
        result: r.result,
        target: r.targetId,
        detail: parsed(r.detail),
      };
    }),
    next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    retentionDays: AUDIT_DAYS,
  });
});
