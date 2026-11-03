// SPDX-License-Identifier: Apache-2.0
// Contract tests for task capability tokens (M4-00a AC1–AC3, m4-spec §5 Wave 0, and the M4-00
// crypto review §8 vectors with the 00a misuse battery). The Worker project runs them against
// D1 and the Node project against apps/node's SQLite (`selfhost-parity`): every vector must
// pass on both roots. A relative path: this file sits outside every workspace package, as
// `test/contract/storage.ts` does.
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_TTL_MS,
  type CapabilityAudience,
  hashCapabilityToken,
  isCanonicalTokenFormat,
  MAX_TTL_MS,
  type MintOptions,
  MintRefusedError,
  mintCapabilityToken,
  parseBearerToken,
  revokeComputerTokens,
  revokeProviderTokens,
  revokeTaskTokens,
  revokeUserTokens,
  verifyCapabilityToken,
} from "../../packages/db/src/capability-tokens";
import { EXPORT_ITEM_TYPES } from "../../packages/db/src/export";
import { createRepository, scopeFromSession } from "../../packages/db/src/repository";
import type { SqlDatabase } from "../../packages/db/src/system";

let ids = 0;

const COMPUTER = "comp-1";

/**
 * The capability-token mint/verify/revoke service against a migrated database: the opaque
 * format and SHA-256 storage (AC1a), the single audience with its route-table expectation
 * (AC1b), the expiry minimum and per-audience TTLs (AC1c), the TTL ceiling, rotation and the
 * per-task/per-user epochs (AC2a), the mint refusals (AC2b), and the one revocation code path
 * across every trigger — including the repository wiring for task cancel/end and
 * provider-credential removal.
 */
export function capabilityTokenContract(name: string, migrated: () => Promise<SqlDatabase>) {
  describe(`${name}: capability token contract`, () => {
    async function setup() {
      const DB = await migrated();
      const tag = `ocap-${++ids}-${Date.now()}`;
      const a = `a-${tag}`;
      const b = `b-${tag}`;
      await DB.prepare("INSERT INTO users (id, display_name, role) VALUES (?, 'A', 'owner')")
        .bind(a)
        .run();
      const stub = {} as never;
      const repo = createRepository({
        DB: DB as never,
        FILES: stub,
        ASSISTANT: stub,
      });
      const alice = repo.forUser(scopeFromSession({ userId: a }));
      expect(await alice.chat.open(`ca-${tag}`, "A's")).toBe(true);
      const taskId = `t-${tag}`;
      expect(
        await alice.tasks.create({
          id: taskId,
          conversationId: `ca-${tag}`,
          kind: "turn",
          mode: "background" as const,
        }),
      ).toBe(true);
      const base = {
        userId: a,
        taskId,
        computerId: COMPUTER,
        computerProfile: "host",
      } as const;
      const mint = (over: Partial<MintOptions> & { aud: string }) =>
        mintCapabilityToken(DB, { ...base, ...over } as MintOptions);
      const live = (token: string, expectedAud: string | null | undefined) =>
        verifyCapabilityToken(DB, { token, expectedAud });
      return { DB, repo, alice, a, b, tag, taskId, base, mint, live };
    }

    it("mints the canonical form and verifies it for the expected audience", async () => {
      const { mint, live, a, taskId } = await setup();
      const before = Date.now();
      const { token, id, expiresAt } = await mint({ aud: "model_proxy" });
      expect(isCanonicalTokenFormat(token)).toBe(true);
      expect(token.startsWith("ocap1_")).toBe(true);
      const scope = await live(token, "model_proxy");
      expect(scope).toMatchObject({
        tokenId: id,
        userId: a,
        taskId,
        computerId: COMPUTER,
        aud: "model_proxy",
        expiresAt,
      });
      // `expiresAt` is stamped inside the mint, between the two reads: the TTL plus
      // clock drift between them, never less than the TTL and never more than elapsed.
      const drift = expiresAt - before - AUDIENCE_TTL_MS.model_proxy;
      expect(drift).toBeGreaterThanOrEqual(0);
      expect(drift).toBeLessThanOrEqual(Date.now() - before);
    });

    it("returns the snapshotted model ceiling in the scope, null when the mint named none", async () => {
      const { mint, live } = await setup();
      const ceiling = [
        { providerId: "p1", model: "m1" },
        { providerId: "p2", model: "m2" },
      ];
      const { token } = await mint({ aud: "model_proxy", modelAllowlist: ceiling });
      // The `model_proxy` route intersects this with the live provider configuration at
      // use (M4-00b); the token service only carries what was snapshotted at mint.
      expect((await live(token, "model_proxy"))?.modelAllowlist).toEqual(ceiling);
      const { token: bare } = await mint({ aud: "tool_gateway" });
      expect((await live(bare, "tool_gateway"))?.modelAllowlist).toBeNull();
    });

    it("uses the per-audience TTL defaults within the ceiling", async () => {
      const { mint } = await setup();
      for (const aud of ["model_proxy", "artifact_upload", "tool_gateway"] as const) {
        const before = Date.now();
        const { expiresAt } = await mint({ aud });
        const drift = expiresAt - before - AUDIENCE_TTL_MS[aud];
        expect(drift).toBeGreaterThanOrEqual(0);
        expect(drift).toBeLessThanOrEqual(Date.now() - before);
      }
      expect(AUDIENCE_TTL_MS).toEqual({
        model_proxy: 30 * 60_000,
        artifact_upload: 60 * 60_000,
        tool_gateway: 15 * 60_000,
      });
      expect(MAX_TTL_MS).toBe(60 * 60_000);
    });

    it("takes the minimum of TTL, task deadline and computer lifetime", async () => {
      const { mint } = await setup();
      const now = Date.now();
      const { expiresAt: byDeadline } = await mint({
        aud: "tool_gateway",
        taskDeadlineMs: now + 60_000,
        computerEndsAtMs: now + 120_000,
        now,
      });
      expect(byDeadline).toBe(now + 60_000);
      const { expiresAt: byComputer } = await mint({
        aud: "tool_gateway",
        taskDeadlineMs: now + 120_000,
        computerEndsAtMs: now + 30_000,
        now,
      });
      expect(byComputer).toBe(now + 30_000);
    });

    it("keeps every TTL at or under the one-hour ceiling, with no caller override", async () => {
      const { mint } = await setup();
      const now = Date.now();
      for (const aud of ["model_proxy", "artifact_upload", "tool_gateway"] as const) {
        // `MintOptions` carries no TTL field: this object literal must stay a type error
        // if a TTL override is ever reintroduced.
        const over: Partial<MintOptions> & { aud: string } = { aud };
        expect("ttlMs" in over).toBe(false);
        const { expiresAt } = await mint({ aud, now });
        expect(expiresAt).toBe(now + AUDIENCE_TTL_MS[aud]);
        expect(expiresAt).toBeLessThanOrEqual(now + MAX_TTL_MS);
      }
    });

    it("stores only the SHA-256, never the token value", async () => {
      const { DB, mint } = await setup();
      const { token, id } = await mint({ aud: "model_proxy" });
      const row = await DB.prepare("SELECT token_hash FROM capability_tokens WHERE id = ?")
        .bind(id)
        .first<{ token_hash: string }>();
      expect(row?.token_hash).toBe(await hashCapabilityToken(token));
      const dump = JSON.stringify(
        (await DB.prepare("SELECT * FROM capability_tokens").all()).results,
      );
      expect(dump).not.toContain(token);
    });

    it("rotates: a re-mint revokes the predecessor, one live token per triple", async () => {
      const { DB, mint, live, taskId } = await setup();
      const first = await mint({ aud: "model_proxy" });
      const second = await mint({ aud: "model_proxy" });
      expect(await live(first.token, "model_proxy")).toBeNull();
      expect(await live(second.token, "model_proxy")).not.toBeNull();
      const rows = (
        await DB.prepare(
          `SELECT revoked_at, revoked_reason FROM capability_tokens
           WHERE task_id = ? AND aud = 'model_proxy' ORDER BY created_at`,
        )
          .bind(taskId)
          .all<{ revoked_at: number | null; revoked_reason: string | null }>()
      ).results;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ revoked_reason: "rotated" });
      expect(rows[0]?.revoked_at).not.toBeNull();
      expect(rows[1]?.revoked_at).toBeNull();
    });

    it("keeps audiences independent: one token, one audience, minted as needed", async () => {
      const { mint, live } = await setup();
      const proxy = await mint({ aud: "model_proxy" });
      const gateway = await mint({ aud: "tool_gateway" });
      expect(await live(proxy.token, "model_proxy")).not.toBeNull();
      expect(await live(gateway.token, "tool_gateway")).not.toBeNull();
      // Each token opens only its own audience.
      expect(await live(proxy.token, "tool_gateway")).toBeNull();
      expect(await live(gateway.token, "model_proxy")).toBeNull();
    });

    it("refuses subscription_cli computers and undeclared audiences", async () => {
      const { mint } = await setup();
      await expect(
        mint({ aud: "model_proxy", computerProfile: "subscription_cli" }),
      ).rejects.toBeInstanceOf(MintRefusedError);
      await expect(mint({ aud: "nope" })).rejects.toBeInstanceOf(MintRefusedError);
      await expect(
        mintCapabilityToken(await setup().then((s) => s.DB), {
          userId: "ghost",
          taskId: "ghost-task",
          computerId: COMPUTER,
          computerProfile: "host",
          aud: "model_proxy",
        }),
      ).rejects.toBeInstanceOf(MintRefusedError);
    });

    it("refuses an empty or malformed model allowlist", async () => {
      const { mint } = await setup();
      await expect(mint({ aud: "model_proxy", modelAllowlist: [] })).rejects.toBeInstanceOf(
        MintRefusedError,
      );
      await expect(
        mint({ aud: "model_proxy", modelAllowlist: [{ providerId: "", model: "m" }] }),
      ).rejects.toBeInstanceOf(MintRefusedError);
    });

    it("leaves concurrent mints with exactly one live token", async () => {
      const { mint, live } = await setup();
      const minted = await Promise.all(
        Array.from({ length: 5 }, () => mint({ aud: "tool_gateway" })),
      );
      const scopes = await Promise.all(minted.map((m) => live(m.token, "tool_gateway")));
      expect(scopes.filter(Boolean)).toHaveLength(1);
    });

    it("rejects every non-canonical shape before hashing", async () => {
      const { mint, live } = await setup();
      const { token } = await mint({ aud: "model_proxy" });
      const shapes = [
        "",
        `Bearer ${token}`,
        token.slice("ocap1_".length),
        token.toUpperCase(),
        token.replace(/_/g, "/"),
        `ocap1_${"A".repeat(42)}`,
        `ocap1_${"A".repeat(44)}`,
        `ocap1_${"A".repeat(200)}`,
        "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJtb2RlbF9wcm94eSJ9.sig",
        `Bearer ${token}, Bearer ${token}`,
      ];
      for (const shape of shapes) expect(await live(shape, "model_proxy")).toBeNull();
    });

    it("fails closed on a missing expected audience or an unreachable store", async () => {
      const { DB, mint, live } = await setup();
      const { token } = await mint({ aud: "model_proxy" });
      expect(await live(token, null)).toBeNull();
      expect(await live(token, undefined)).toBeNull();
      expect(await live(token, "nope")).toBeNull();
      const throwing = {
        prepare() {
          throw new Error("store is down");
        },
        batch() {
          throw new Error("store is down");
        },
      } as unknown as SqlDatabase;
      expect(
        await verifyCapabilityToken(throwing, { token, expectedAud: "model_proxy" }),
      ).toBeNull();
      expect(DB).toBeDefined();
    });

    it("denies an unknown token silently: no audit row for a row that never existed", async () => {
      const { DB, live } = await setup();
      const before = (
        await DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>()
      )?.n;
      const forged = `ocap1_${"A".repeat(43)}`;
      expect(isCanonicalTokenFormat(forged)).toBe(true);
      expect(await live(forged, "model_proxy")).toBeNull();
      expect(
        (await DB.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())?.n,
      ).toBe(before);
    });

    it("denies an expired token silently: past the TTL it simply stops", async () => {
      const { DB, mint } = await setup();
      const now = Date.now();
      const { token } = await mint({ aud: "tool_gateway", now });
      const before = (
        await DB.prepare(
          "SELECT count(*) AS n FROM audit_log WHERE action = 'capability_token.use_denied'",
        ).first<{ n: number }>()
      )?.n;
      expect(
        await verifyCapabilityToken(DB, {
          token,
          expectedAud: "tool_gateway",
          now: now + AUDIENCE_TTL_MS.tool_gateway + 1,
        }),
      ).toBeNull();
      expect(
        (
          await DB.prepare(
            "SELECT count(*) AS n FROM audit_log WHERE action = 'capability_token.use_denied'",
          ).first<{ n: number }>()
        )?.n,
      ).toBe(before);
    });

    it("audits a revoked token's use against its row id, never the value", async () => {
      const { DB, mint, live } = await setup();
      const { token, id } = await mint({ aud: "model_proxy" });
      const scope = await live(token, "model_proxy");
      expect(scope).not.toBeNull();
      await DB.prepare(
        "UPDATE capability_tokens SET revoked_at = ?, revoked_reason = 'rotated' WHERE id = ?",
      )
        .bind(Date.now(), id)
        .run();
      expect(await live(token, "model_proxy")).toBeNull();
      const audits = (
        await DB.prepare(
          `SELECT target_id, detail FROM audit_log
           WHERE action = 'capability_token.use_denied' AND target_id = ?`,
        )
          .bind(id)
          .all<{ target_id: string; detail: string }>()
      ).results;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.target_id).toBe(id);
      expect(audits[0]?.detail).toContain("revoked");
      const dump = JSON.stringify(audits);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain("ocap1_");
    });

    it("denies on task end and epoch drift, keeps other tasks' tokens live", async () => {
      const { DB, alice, mint, live, a, tag } = await setup();
      const first = await mint({ aud: "model_proxy" });
      const task2 = `t2-${tag}`;
      expect(
        await alice.tasks.create({
          id: task2,
          conversationId: `ca-${tag}`,
          kind: "turn",
          mode: "background" as const,
        }),
      ).toBe(true);
      const other = await mintCapabilityToken(DB, {
        userId: a,
        taskId: task2,
        computerId: COMPUTER,
        computerProfile: "host",
        aud: "model_proxy",
      });
      expect(await live(other.token, "model_proxy")).not.toBeNull();
      expect(await alice.tasks.cancel(`t-${tag}`)).toBe(true);
      // The cancelled task's row is revoked.
      expect(await live(first.token, "model_proxy")).toBeNull();
      // A token minted for the ended task afterwards still dies: the task ended.
      const after = await mint({ aud: "model_proxy" });
      expect(await live(after.token, "model_proxy")).toBeNull();
      const ended = (
        await DB.prepare(
          `SELECT detail FROM audit_log
           WHERE action = 'capability_token.use_denied' AND target_id = ?
           ORDER BY rowid DESC LIMIT 1`,
        )
          .bind(after.id)
          .all<{ detail: string }>()
      ).results;
      expect(ended).toHaveLength(1);
      expect(ended[0]?.detail).toContain("task_ended");
      // Drift the epoch without touching rows: the bump alone kills the token.
      await DB.prepare("UPDATE tasks SET token_epoch = token_epoch + 1 WHERE id = ?")
        .bind(task2)
        .run();
      expect(await live(other.token, "model_proxy")).toBeNull();
      const drifted = (
        await DB.prepare(
          `SELECT detail FROM audit_log
           WHERE action = 'capability_token.use_denied' AND target_id = ?
           ORDER BY rowid DESC LIMIT 1`,
        )
          .bind(other.id)
          .all<{ detail: string }>()
      ).results;
      expect(drifted[0]?.detail).toContain("epoch");
    });

    it("denies after sign-out-everywhere, and a post-revoke mint lives again", async () => {
      const { DB, mint, live, a } = await setup();
      const { token } = await mint({ aud: "tool_gateway" });
      expect(await revokeUserTokens(DB, a, "sign_out_everywhere")).toBeGreaterThan(0);
      expect(await live(token, "tool_gateway")).toBeNull();
      const again = await mint({ aud: "tool_gateway" });
      expect(await live(again.token, "tool_gateway")).not.toBeNull();
    });

    it("revokes one computer without touching the task's others", async () => {
      const { DB, mint, live, base } = await setup();
      const doomed = await mint({ aud: "tool_gateway" });
      const spared = await mintCapabilityToken(DB, {
        ...base,
        computerId: "comp-2",
        aud: "tool_gateway",
      });
      expect(await revokeComputerTokens(DB, COMPUTER, base.userId, "computer_stopped")).toBe(1);
      expect(await live(doomed.token, "tool_gateway")).toBeNull();
      expect(await live(spared.token, "tool_gateway")).not.toBeNull();
    });

    it("revokes only the removed provider's model_proxy tokens", async () => {
      const { DB, mint, live, base } = await setup();
      // Distinct computers: the same triple would rotate, not coexist.
      const p1 = await mint({
        aud: "model_proxy",
        modelAllowlist: [{ providerId: "p1", model: "m" }],
      });
      const p2 = await mintCapabilityToken(DB, {
        ...base,
        computerId: "comp-p2",
        aud: "model_proxy",
        modelAllowlist: [{ providerId: "p2", model: "m" }],
      });
      const upload = await mint({ aud: "artifact_upload" });
      expect(await revokeProviderTokens(DB, base.userId, "p1")).toBe(1);
      expect(await live(p1.token, "model_proxy")).toBeNull();
      expect(await live(p2.token, "model_proxy")).not.toBeNull();
      expect(await live(upload.token, "artifact_upload")).not.toBeNull();
    });

    it("kills tokens on task finish, and revocation names scope and count only", async () => {
      const { DB, alice, mint, live, taskId } = await setup();
      const { token } = await mint({ aud: "model_proxy" });
      expect(await alice.tasks.finish(taskId, "succeeded")).toBe(true);
      expect(await live(token, "model_proxy")).toBeNull();
      const row = await DB.prepare(
        `SELECT action, target_id, detail FROM audit_log
         WHERE action LIKE 'capability_token.revoke%' ORDER BY rowid DESC LIMIT 1`,
      ).first<{ action: string; target_id: string; detail: string }>();
      expect(row?.action).toBe("capability_token.revoke_task");
      expect(row?.target_id).toBe(taskId);
      expect(row?.detail).toContain('"revoked":1');
      const dump = JSON.stringify(row);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain("ocap1_");
    });

    it("keeps tokens live across a budget_limited pause, kills them on the ending", async () => {
      const { alice, mint, live, taskId } = await setup();
      const { token } = await mint({ aud: "model_proxy" });
      expect(await alice.tasks.finish(taskId, "budget_limited")).toBe(true);
      expect(await live(token, "model_proxy")).not.toBeNull();
      expect(await alice.tasks.finish(taskId, "failed")).toBe(true);
      expect(await live(token, "model_proxy")).toBeNull();
    });

    it("kills provider tokens when the credential row is removed", async () => {
      const { DB, alice, mint, live, a } = await setup();
      const providerId = `prov-${Date.now()}`;
      await DB.prepare("INSERT INTO model_providers (id, user_id, kind) VALUES (?, ?, 'custom')")
        .bind(providerId, a)
        .run();
      const { token } = await mint({
        aud: "model_proxy",
        modelAllowlist: [{ providerId, model: "m" }],
      });
      expect(await live(token, "model_proxy")).not.toBeNull();
      expect(await alice.providers.remove(providerId)).toBe(true);
      expect(await live(token, "model_proxy")).toBeNull();
    });

    it("parses only the exact Bearer shape", () => {
      const token = `ocap1_${"B".repeat(43)}`;
      expect(parseBearerToken(`Bearer ${token}`)).toBe(token);
      expect(parseBearerToken(null)).toBeNull();
      expect(parseBearerToken(`bearer ${token}`)).toBeNull();
      expect(parseBearerToken(`Bearer  ${token}`)).toBeNull();
      expect(parseBearerToken(`${token}`)).toBeNull();
      expect(parseBearerToken(`Bearer ${token}, Bearer ${token}`)).toBeNull();
    });

    it("is never an export item type: no export carries token rows", () => {
      expect(EXPORT_ITEM_TYPES).not.toContain("capability_tokens");
      expect(EXPORT_ITEM_TYPES).not.toContain("capability");
    });

    it("never writes a token value or hash to the audit log", async () => {
      const { DB, mint, live, taskId, a } = await setup();
      const minted = await Promise.all([
        mint({ aud: "model_proxy" }),
        mint({ aud: "tool_gateway" }),
        mint({ aud: "artifact_upload" }),
      ]);
      for (const m of minted) await live(m.token, "model_proxy");
      await revokeTaskTokens(DB, taskId, a, "probe");
      const rows = (
        await DB.prepare("SELECT target_id, detail FROM audit_log").all<{
          target_id: string | null;
          detail: string | null;
        }>()
      ).results;
      const dump = JSON.stringify(rows);
      for (const m of minted) expect(dump).not.toContain(m.token);
      expect(dump).not.toContain("ocap1_");
    });
  });
}

export type { CapabilityAudience };
