const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function assertTrustedHubOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `Rejected hub origin ${origin}: the hub origin must be an https URL, or plaintext http on localhost for development.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Rejected hub origin ${origin}: the hub origin must be an https URL, or plaintext http on localhost for development.`,
    );
  }
  if (parsed.protocol === "https:") return;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Rejected hub origin ${origin}: plaintext http is only allowed on localhost for development; use https.`,
    );
  }
}

/**
 * Prefix for hub requests: VITE_HUB_URL when the hub is on another origin, or
 * "" when this origin reaches it (the hub serves the portal, a host rewrite,
 * or the Vite dev proxy).
 */
export function requestOrigin(): string {
  const configured = import.meta.env.VITE_HUB_URL?.trim().replace(/\/$/, "");
  if (!configured) return "";
  assertTrustedHubOrigin(configured);
  return configured;
}

/** Absolute origin GitHub and users reach the hub at. */
export function hubOrigin(): string {
  return requestOrigin() || window.location.origin;
}

export function hubConfigured(): boolean {
  try {
    requestOrigin();
    return true;
  } catch {
    return false;
  }
}
