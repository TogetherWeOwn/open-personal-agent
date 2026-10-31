// SPDX-License-Identifier: Apache-2.0
// Spike B: better-auth with its passkey plugin, passkey-first (no email/password), D1 via the native dialect.
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, betterAuth } from "better-auth";

export type Env = { DB: D1Database; RP_ID: string; ORIGIN: string; AUTH_SECRET: string };

export const authOptions = (env: Env) =>
  ({
    database: env.DB,
    secret: env.AUTH_SECRET,
    baseURL: env.ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [env.ORIGIN],
    telemetry: { enabled: false },
    session: { expiresIn: 90 * 86400, updateAge: 86400 },
    advanced: { useSecureCookies: true },
    plugins: [
      passkey({
        rpID: env.RP_ID,
        rpName: "Open Personal Agent",
        origin: env.ORIGIN,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        registration: {
          requireSession: false,
          resolveUser: () => ({ id: crypto.randomUUID(), name: "owner" }),
          // better-auth's user table needs a unique, non-null email even for passkey-only users.
          afterVerification: async ({ ctx, user }) => {
            const created = await ctx.context.internalAdapter.createUser({
              email: `${user.id}@passkey.invalid`,
              name: user.name,
              emailVerified: false,
            });
            return { userId: created.id };
          },
        },
      }),
    ],
  }) satisfies BetterAuthOptions;

export const makeAuth = (env: Env) => betterAuth(authOptions(env));
