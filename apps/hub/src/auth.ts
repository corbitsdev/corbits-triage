// Stock createAuth minus its unconfigured Google provider, plus the portal's
// origin when the portal is hosted on another origin.
import type { DB } from "@intx/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export type HubAuthConfig = { baseURL: string; secret: string; trustedOrigins: string[] };

export function createHubAuth(db: DB["db"], config: HubAuthConfig) {
  return betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
  });
}
