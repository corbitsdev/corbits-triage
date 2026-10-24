import { expect, test } from "bun:test";
import { authMethods, isEmailAllowed } from "./auth.js";
import { clientIpHeaders, signInSettings, type HubEnv } from "./env.js";

const ALLOWED = ["@corbits.dev", "friend@example.com"];

test("allowlist matches exact addresses and @domains only", () => {
  expect(isEmailAllowed("Sawyer@Corbits.dev", ALLOWED)).toBe(true);
  expect(isEmailAllowed("friend@example.com", ALLOWED)).toBe(true);
  expect(isEmailAllowed("other@example.com", ALLOWED)).toBe(false);
  expect(isEmailAllowed("evil@corbits.dev.attacker.com", ALLOWED)).toBe(false);
  expect(isEmailAllowed("evil@notcorbits.dev", ALLOWED)).toBe(false);
});

test("an allowlist requires Google or email, and admits email/password only when the hub can verify it", () => {
  const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as HubEnv;
  expect(() => signInSettings({ AUTH_ALLOWED_EMAILS: "@corbits.dev" } as HubEnv)).toThrow("requires Google sign-in");
  expect(signInSettings({ AUTH_ALLOWED_EMAILS: "@corbits.dev", SMTP_URL: "smtp://mail.test" } as HubEnv)).toEqual({ allowedEmails: ["@corbits.dev"] });
  expect(() => signInSettings({ GOOGLE_CLIENT_ID: "id" } as HubEnv)).toThrow("must be set together");
  expect(() => signInSettings({ ...google, AUTH_ALLOWED_EMAILS: " , " })).toThrow("lists no address");
  expect(authMethods(signInSettings({ ...google, AUTH_ALLOWED_EMAILS: "@corbits.dev" }), false)).toEqual({ google: true, emailPassword: false, passwordReset: false, verificationEmail: false });
  expect(authMethods(signInSettings({ ...google, AUTH_ALLOWED_EMAILS: "@corbits.dev", SMTP_URL: "smtp://mail.test" } as HubEnv), true)).toEqual({ google: true, emailPassword: true, passwordReset: true, verificationEmail: true });
  expect(authMethods(signInSettings(google), false)).toEqual({ google: true, emailPassword: true, passwordReset: false, verificationEmail: false });
});

test("the caller's address comes from the header a detected host sets, and none elsewhere", () => {
  expect(clientIpHeaders({ RAILWAY_ENVIRONMENT_ID: "env" })).toEqual(["x-real-ip"]);
  expect(clientIpHeaders({})).toBeUndefined();
});
