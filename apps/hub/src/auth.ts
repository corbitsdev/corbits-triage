// Stock createAuth plus the operator's sign-in settings and the portal's
// origin when the portal is hosted on another origin.
import type { DB } from "@intx/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { SignInSettings } from "./env.js";

export const AUTH_METHODS_PATH = "/api/integrations/auth-methods";

export type HubAuthConfig = SignInSettings & { baseURL: string; secret: string; trustedOrigins: string[] };

/** Entries are exact addresses or `@domain`. */
export function isEmailAllowed(email: string, allowedEmails: readonly string[]): boolean {
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@"));
  return allowedEmails.includes(address) || allowedEmails.includes(domain);
}

export function authMethods(config: SignInSettings): { google: boolean; emailPassword: boolean } {
  return { google: config.google !== undefined, emailPassword: config.allowedEmails === undefined };
}

export function createHubAuth(db: DB["db"], config: HubAuthConfig) {
  const { allowedEmails, google } = config;

  function requireAllowed(user: { email: string; emailVerified: boolean } | null) {
    if (allowedEmails === undefined) return;
    if (user === null || !user.emailVerified || !isEmailAllowed(user.email, allowedEmails)) {
      throw new APIError("FORBIDDEN", { message: "This email is not allowed to sign in." });
    }
  }

  async function requireAllowedNewUser(user: { email: string; emailVerified: boolean }) {
    requireAllowed(user);
  }

  return betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: authMethods(config).emailPassword },
    ...(google && { socialProviders: { google } }),
    databaseHooks: {
      user: { create: { before: requireAllowedNewUser } },
      // Also checked per session, so accounts that predate the allowlist are held to it.
      session: {
        create: {
          async before(session, ctx) {
            if (allowedEmails === undefined) return;
            requireAllowed(ctx === null ? null : await ctx.context.internalAdapter.findUserById(session.userId));
          },
        },
      },
    },
  });
}
