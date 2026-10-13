// Stock createAuth plus the operator's sign-in settings and the portal's
// origin when the portal is hosted on another origin, and device-code sign-in
// for agents acting as a person, who then call the hub with a bearer token.
import { schema, type DB } from "@intx/db";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { makeSignature } from "better-auth/crypto";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import { lt } from "drizzle-orm";
import { integer, text, timestamp } from "drizzle-orm/pg-core";
import type { SignInSettings } from "./env.js";
import { triageSchema } from "./triage-db.js";

export const AUTH_METHODS_PATH = "/api/integrations/auth-methods";

/** The only client the device flow signs in: an agent acting for the person who approves its code. */
const DEVICE_CLIENT_ID = "corbits-cli";

export type HubAuthConfig = SignInSettings & { baseURL: string; secret: string; trustedOrigins: string[]; portalOrigin: string };

export const deviceCode = triageSchema.table("device_code", {
  id: text("id").primaryKey(),
  deviceCode: text("device_code").notNull().unique(),
  userCode: text("user_code").notNull().unique(),
  userId: text("user_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  pollingInterval: integer("polling_interval"),
  clientId: text("client_id"),
  scope: text("scope"),
});

type AuthMiddlewareContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

// bearer() hands every new session to page JS as `set-auth-token`; only the device flow needs a bearer token, in its body.
async function stripSetAuthToken(ctx: AuthMiddlewareContext) {
  const headers = ctx.context.responseHeaders;
  if (!headers?.has("set-auth-token")) return;
  headers.delete("set-auth-token");
  const exposed = (headers.get("access-control-expose-headers") ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0 && name.toLowerCase() !== "set-auth-token");
  if (exposed.length > 0) headers.set("access-control-expose-headers", exposed.join(", "));
  else headers.delete("access-control-expose-headers");
}

const withoutSetAuthToken: BetterAuthPlugin = {
  id: "without-set-auth-token",
  hooks: { after: [{ matcher: () => true, handler: createAuthMiddleware(stripSetAuthToken) }] },
};

function isDeviceToken(body: unknown): body is { access_token: string } {
  return typeof body === "object" && body !== null && "access_token" in body && typeof body.access_token === "string";
}

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

  // Codes nobody redeemed stay behind; each new request clears the expired ones.
  async function deleteExpiredDeviceCodes() {
    await db.delete(deviceCode).where(lt(deviceCode.expiresAt, new Date()));
  }

  async function signDeviceToken(ctx: AuthMiddlewareContext) {
    const body = ctx.context.returned;
    if (ctx.path !== "/device/token" || !isDeviceToken(body)) return;
    return ctx.json({ ...body, access_token: `${body.access_token}.${await makeSignature(body.access_token, config.secret)}` });
  }

  return betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema: { ...schema, deviceCode } }),
    emailAndPassword: { enabled: authMethods(config).emailPassword },
    // better-auth only rate-limits when NODE_ENV is production, which the deployment does not set.
    rateLimit: { enabled: true, customRules: { "/device/code": { window: 60, max: 5 } } },
    ...(google && { socialProviders: { google } }),
    plugins: [
      bearer({ requireSignature: true }),
      withoutSetAuthToken,
      deviceAuthorization({
        validateClient: (clientId) => clientId === DEVICE_CLIENT_ID,
        verificationUri: new URL("/device", config.portalOrigin).toString(),
        onDeviceAuthRequest: deleteExpiredDeviceCodes,
      }),
    ],
    // The device token is a raw session token; sign it like the session cookie so bearer() accepts only signed tokens.
    hooks: { after: createAuthMiddleware(signDeviceToken) },
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
