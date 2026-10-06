// Same calls as Solutions Builder. No local session record stands in for the hub cookie.
import { ApiError } from "@intx/hub-client";
import { hubOrigin, requestOrigin } from "./hub-origin.ts";

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
  const origin = hubOrigin();
  if (!origin) {
    throw new ApiError(0, "hub_not_configured", "The hub is not configured.");
  }
  let response: Response;
  try {
    response = await fetch(`${requestOrigin()}/api/auth${path}`, { ...init, credentials: "include" });
  } catch {
    throw new ApiError(
      0,
      "host_unreachable",
      "The hub is unreachable. Auto-advance is denied.",
    );
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
    throw new ApiError(response.status, "unknown", messageOf(parsed, `HTTP ${response.status}`));
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

/** Creates the hub account; the display name defaults to the email's local part. */
export function signUpHub(input: { email: string; password: string }): Promise<HubUser> {
  return emailAuth("/sign-up/email", { ...input, name: input.email.split("@")[0] ?? input.email }, "create the account");
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
