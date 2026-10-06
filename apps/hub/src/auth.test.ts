import { expect, test } from "bun:test";
import { authMethods, isEmailAllowed } from "./auth.js";
import { signInSettings, type HubEnv } from "./env.js";

const ALLOWED = ["@corbits.dev", "friend@example.com"];

test("allowlist matches exact addresses and @domains only", () => {
  expect(isEmailAllowed("Sawyer@Corbits.dev", ALLOWED)).toBe(true);
  expect(isEmailAllowed("friend@example.com", ALLOWED)).toBe(true);
  expect(isEmailAllowed("other@example.com", ALLOWED)).toBe(false);
  expect(isEmailAllowed("evil@corbits.dev.attacker.com", ALLOWED)).toBe(false);
  expect(isEmailAllowed("evil@notcorbits.dev", ALLOWED)).toBe(false);
});

test("an allowlist requires Google and turns email/password off", () => {
  const google = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" } as HubEnv;
  expect(() => signInSettings({ AUTH_ALLOWED_EMAILS: "@corbits.dev" } as HubEnv)).toThrow("requires Google");
  expect(() => signInSettings({ GOOGLE_CLIENT_ID: "id" } as HubEnv)).toThrow("must be set together");
  expect(authMethods(signInSettings({ ...google, AUTH_ALLOWED_EMAILS: "@corbits.dev" }))).toEqual({ google: true, emailPassword: false });
  expect(authMethods(signInSettings(google))).toEqual({ google: true, emailPassword: true });
});
