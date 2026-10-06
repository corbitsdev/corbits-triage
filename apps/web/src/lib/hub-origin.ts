// SPDX-License-Identifier: GPL-2.0-only

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

/** The hub origin from VITE_HUB_URL, with no trailing slash, or null when it is unset or blank. */
export function hubOrigin(): string | null {
  const trimmed = import.meta.env.VITE_HUB_URL?.trim().replace(/\/$/, "");
  if (!trimmed) return null;
  assertTrustedHubOrigin(trimmed);
  return trimmed;
}

export function hubConfigured(): boolean {
  try {
    return hubOrigin() !== null;
  } catch {
    return false;
  }
}

/** In dev, browser calls stay on the portal origin because the hub sends no CORS headers; Vite forwards `/api` to it. */
export function requestOrigin(): string {
  if (typeof window !== "undefined" && window.location.port === "5173") return "";
  const origin = hubOrigin();
  if (!origin) throw new Error("VITE_HUB_URL is not configured.");
  return origin;
}
