// SPDX-License-Identifier: Apache-2.0
// The export start's lost-insert race (M3-20 AC1): a second POST that passes the
// pre-check, then loses the one-running partial unique index, answers 409
// `already_running` like the pre-check does — the repository-level test pins the index,
// this one pins the route's `isUniqueViolation` mapping.
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Browser, claim, count, db, env, freshDatabase, type passkey } from "./helpers/app";

const race = vi.hoisted(() => ({ failCreate: false, runningCalls: 0 }));

vi.mock("@opa/db/repository", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@opa/db/repository")>();
  const createRepository: typeof mod.createRepository = ((
    bindings: Parameters<typeof mod.createRepository>[0],
  ) => {
    const repo = mod.createRepository(bindings);
    const forUser = repo.forUser.bind(repo);
    return {
      ...repo,
      forUser: (scope: Parameters<typeof forUser>[0]) => {
        const user = forUser(scope);
        return {
          ...user,
          exports: {
            ...user.exports,
            running: async () => {
              race.runningCalls += 1;
              // The lost race: the pre-check runs before the winner's row lands.
              if (race.failCreate && race.runningCalls === 1) return null;
              return user.exports.running();
            },
            create: async (input: Parameters<typeof user.exports.create>[0]): Promise<boolean> => {
              if (race.failCreate) throw new Error("UNIQUE constraint failed: exports.user_id");
              return user.exports.create(input);
            },
          },
        };
      },
    };
  }) as typeof mod.createRepository;
  return { ...mod, createRepository };
});

freshDatabase();
afterEach(() => {
  vi.restoreAllMocks();
  race.failCreate = false;
  race.runningCalls = 0;
});

/** A row written straight to D1, with no Workflow run behind it: it never leaves `running`. */
async function insertRow(userId: string, id: string, expiresAt: number) {
  await db
    .prepare(
      "INSERT INTO exports (id, user_id, workflow_instance_id, status, expires_at) VALUES (?, ?, ?, 'running', ?)",
    )
    .bind(id, userId, `inst-${id}`, expiresAt)
    .run();
}

/** A passkey step-up in this session, as the account actions require. */
async function stepUp(br: Browser, key: ReturnType<typeof passkey>) {
  const res = await br.req("/api/auth/step-up/session/options", { body: {} });
  const { options } = await res.json<{ options: { challenge: string } }>();
  return br.req("/api/auth/step-up/session", {
    body: { credential: await key.get(options) },
  });
}

describe("POST /api/exports under a lost insert race", () => {
  it("maps the one-running unique violation to 409 already_running", async () => {
    const { browser, key, owner } = await claim();
    expect((await stepUp(browser, key)).status).toBe(200);
    // The winner's row lands after this POST's pre-check but before its insert.
    await insertRow(owner, "r1", Date.now() + 3_600_000);
    race.failCreate = true;
    expect(env.EXPORT_WORKFLOW).toBeDefined();
    const res = await browser.req("/api/exports", { method: "POST", body: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "already_running",
      export: expect.objectContaining({ id: "r1", status: "running" }),
    });
    // The losing insert claimed nothing new.
    expect(await count("exports")).toBe(1);
  });
});
