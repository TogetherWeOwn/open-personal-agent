// SPDX-License-Identifier: Apache-2.0
// The scoped repository layer (ADR 0010 D3): the only code that reads the DB, FILES and ASSISTANT
// bindings, derives R2 keys or names Durable Objects. scripts/check-scoped-access.mjs enforces it.
import { and, desc, eq } from "drizzle-orm";
import type { AnyD1Database } from "drizzle-orm/d1";
// A separate entry point (`@opa/db/repository`), so this import is not a cycle.
import { openD1, readSchemaVersion } from "./index";
import { conversations, users } from "./schema";

declare const brand: unique symbol;
/** A user's authority over their own rows. Only `scopeFromSession` creates one. */
export type UserScope = { readonly userId: string; readonly [brand]: true };

const issued = new WeakSet<object>();

/** For the session layer only (the lint enforces it), after it has validated the session. */
export function scopeFromSession(session: { readonly userId: string }): UserScope {
  if (!session.userId) throw new Error("session has no user");
  const scope = Object.freeze({ userId: session.userId }) as UserScope;
  issued.add(scope);
  return scope;
}

/** The parts of R2 and Durable Object namespaces used here; the Node root supplies its own. */
export interface DataBindings<Stub, Id> {
  DB: AnyD1Database;
  FILES: {
    head(key: string): Promise<unknown>;
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(
      key: string,
      value: string,
      options: { httpMetadata: { contentType: string } },
    ): Promise<unknown>;
  };
  ASSISTANT: { idFromName(name: string): Id; get(id: Id): Stub };
}

/** IDs are server-generated; the check also keeps a key inside the user's R2 prefix. */
function checkId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("invalid id");
  return id;
}

export function createRepository<Stub, Id>({ DB, FILES, ASSISTANT }: DataBindings<Stub, Id>) {
  const db = openD1(DB);
  return {
    /** Deployment-level checks that read no user's data. */
    deployment: {
      schemaVersion: () => readSchemaVersion(db),
      /** A HEAD on a key outside every user's prefix that never exists. */
      probeStorage: () => FILES.head("health/probe"),
      /** A fixed name outside the `u:<userId>` space. */
      healthObject: () => ASSISTANT.get(ASSISTANT.idFromName("health")),
    },

    forUser(scope: UserScope) {
      if (!issued.has(scope)) throw new Error("scope was not issued by the session layer");
      const { userId } = scope;
      const fileKey = (id: string) => `u/${userId}/files/${checkId(id)}`;
      const own = (id: string) => and(eq(conversations.id, id), eq(conversations.userId, userId));
      return {
        /** The user's own `users` row; `undefined` if it was deleted. */
        profile: async () =>
          (
            await db
              .select({ id: users.id, displayName: users.displayName, role: users.role })
              .from(users)
              .where(eq(users.id, userId))
              .limit(1)
          )[0],
        /** The user's assistant (ADR 0002), named from the session, never from client input. */
        assistant: () => ASSISTANT.get(ASSISTANT.idFromName(`u:${userId}`)),
        listConversations: () =>
          db
            .select()
            .from(conversations)
            .where(eq(conversations.userId, userId))
            .orderBy(desc(conversations.updatedAt)),
        /** `undefined` when the row is missing or someone else's: answer 404 for both. */
        getConversation: async (id: string) =>
          (await db.select().from(conversations).where(own(id)).limit(1))[0],
        createConversation: async (id: string, title: string | null = null) => {
          await db.insert(conversations).values({ id: checkId(id), userId, title });
        },
        getFile: (id: string) => FILES.get(fileKey(id)),
        putFile: (id: string, value: string, contentType: string) =>
          FILES.put(fileKey(id), value, { httpMetadata: { contentType } }),
      };
    },
  };
}
