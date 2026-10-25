// Same calls as Solutions Builder. No local session record stands in for the hub cookie.
import { ApiError } from "@intx/hub-client";
import { requestOrigin } from "./hub-origin.ts";
import { createHubTransport, hubErrorMessage } from "./hub-transport.ts";

export type HubUser = {
  id: string;
  name: string;
  email: string;
};

export type HubSession = { user: HubUser } | null;

type AuthJson = {
  user?: { id?: unknown; name?: unknown; email?: unknown } | null;
  message?: unknown;
  error?: { code?: unknown; message?: unknown };
};

async function hubAuth(path: string, init: RequestInit): Promise<{ response: Response; parsed: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${requestOrigin()}/api/auth${path}`, { ...init, credentials: "include" });
  } catch {
    throw new ApiError(0, "host_unreachable", "The hub is unreachable.");
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { response, parsed };
}

function messageOf(parsed: unknown, fallback: string): string {
  const body = parsed as AuthJson | undefined;
  if (typeof body?.message === "string" && body.message.length > 0) return body.message;
  if (typeof body?.error?.message === "string" && body.error.message.length > 0) return body.error.message;
  return fallback;
}

function userOf(parsed: unknown): HubUser | null {
  const user = (parsed as AuthJson | undefined)?.user;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string") return null;
  return {
    id: user.id,
    name: typeof user.name === "string" && user.name.trim().length > 0 ? user.name : user.email,
    email: user.email,
  };
}

export async function getHubSession(): Promise<HubSession> {
  const { response, parsed } = await hubAuth("/get-session", { method: "GET" });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw new ApiError(response.status, "unknown", messageOf(parsed, hubErrorMessage(response.status, parsed)));
  }
  const user = userOf(parsed);
  return user ? { user } : null;
}

async function emailAuth(path: "/sign-in/email" | "/sign-up/email", body: Record<string, string>, verb: string): Promise<HubUser> {
  const { response, parsed } = await hubAuth(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ApiError(response.status, "unknown", messageOf(parsed, `Could not ${verb}.`));
  }
  const user = userOf(parsed);
  if (!user) throw new ApiError(response.status, "unknown", `The hub accepted the ${verb} but did not return a user.`);
  return user;
}

export function signInHub(input: { email: string; password: string }): Promise<HubUser> {
  return emailAuth("/sign-in/email", input, "sign in");
}

/** Where the hub's verification link lands once the address is verified. */
function verifiedLanding(): string {
  return `${window.location.origin}/`;
}

/** Creates the hub account; a blank display name falls back to the email's local part. */
export function signUpHub({ name, ...input }: { name?: string; email: string; password: string }): Promise<HubUser> {
  return emailAuth("/sign-up/email", { ...input, name: name?.trim() || (input.email.split("@")[0] ?? input.email), callbackURL: verifiedLanding() }, "create the account");
}

export async function signOutHub(): Promise<void> {
  const { response, parsed } = await hubAuth("/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok && response.status !== 401) {
    throw new ApiError(response.status, "unknown", messageOf(parsed, "Could not sign out."));
  }
}

export type AuthMethods = { google: boolean; emailPassword: boolean; passwordReset: boolean; verificationEmail: boolean };

export async function getAuthMethods(): Promise<AuthMethods> {
  const body = await createHubTransport().fetch<Partial<AuthMethods> | undefined>("GET", "/api/integrations/auth-methods");
  if (!body || typeof body.google !== "boolean" || typeof body.emailPassword !== "boolean" || typeof body.passwordReset !== "boolean" || typeof body.verificationEmail !== "boolean") {
    throw new Error("The hub returned malformed sign-in options.");
  }
  return { google: body.google, emailPassword: body.emailPassword, passwordReset: body.passwordReset, verificationEmail: body.verificationEmail };
}

export async function signInWithGoogle(): Promise<void> {
  const returnTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const { response, parsed } = await hubAuth("/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "google", callbackURL: returnTo, errorCallbackURL: returnTo }),
  });
  const url = (parsed as { url?: unknown } | undefined)?.url;
  if (!response.ok || typeof url !== "string") {
    throw new ApiError(response.status, "unknown", messageOf(parsed, "Could not start Google sign-in."));
  }
  window.location.assign(url);
}

export async function claimDeviceCode(userCode: string): Promise<string> {
  const { response, parsed } = await hubAuth(`/device?user_code=${encodeURIComponent(userCode)}`, { method: "GET" });
  const clientId = (parsed as { client_id?: unknown } | undefined)?.client_id;
  if (!response.ok || typeof clientId !== "string") throw new ApiError(response.status, "unknown", messageOf(parsed, "That code is not valid."));
  return clientId;
}

export async function decideDeviceCode(userCode: string, decision: "approve" | "deny"): Promise<void> {
  const { response, parsed } = await hubAuth(`/device/${decision}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  if (!response.ok) throw new ApiError(response.status, "unknown", messageOf(parsed, `Could not ${decision} the device.`));
}

/** Portal path the hub's password reset email returns to, with `?token=` or `?error=`. */
export const RESET_PASSWORD_PATH = "/reset-password";

async function postAuth(path: string, body: Record<string, string>, failed: string): Promise<void> {
  const { response, parsed } = await hubAuth(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, "unknown", messageOf(parsed, failed));
}

export function requestPasswordReset(email: string): Promise<void> {
  return postAuth("/request-password-reset", { email, redirectTo: `${window.location.origin}${RESET_PASSWORD_PATH}` }, "Could not send the reset email.");
}

export function resendVerificationEmail(email: string): Promise<void> {
  return postAuth("/send-verification-email", { email, callbackURL: verifiedLanding() }, "Could not send the link.");
}

export function resetPassword(token: string, newPassword: string): Promise<void> {
  return postAuth("/reset-password", { token, newPassword }, "Could not set the password.");
}

export async function hasSignInMethod(): Promise<boolean> {
  const { response, parsed } = await hubAuth("/list-accounts", { method: "GET" });
  if (!response.ok || !Array.isArray(parsed)) throw new ApiError(response.status, "unknown", messageOf(parsed, "Could not read the account."));
  return parsed.length > 0;
}
