/** The local part of the tenant system sender the hub mails triage requests as. */
export const TRIAGE_MAIL_SENDER = "github";

const BARE_ADDRESS = /^([^\s@<>",()]+)@([^\s@<>",()]+)$/;

function bareAddress(value: unknown): { local: string; domain: string } | undefined {
  const match = typeof value === "string" ? BARE_ADDRESS.exec(value.trim()) : null;
  return match ? { local: match[1]!, domain: match[2]!.toLowerCase() } : undefined;
}

/**
 * Whether the trigger mail came from the hub's triage sender. Stock admits a mail only when its `From` names the sender
 * the hub authenticated, but a display name is free text, so only the bare address the hub writes is trusted, and only
 * from the domain of the deployment it was sent to.
 */
export function isFromTriageSender(payload: unknown): boolean {
  const headers = asRecord(asRecord(parsed(payload))?.["headers"]);
  const from = bareAddress(headers?.["from"]);
  const to = headers?.["to"];
  if (from?.local !== TRIAGE_MAIL_SENDER || !Array.isArray(to) || to.length !== 1) return false;
  return bareAddress(to[0])?.domain === from.domain;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The request a run's trigger carried: stock stores the trigger mail with the request JSON as inline text of a part (none for a part stored by ref), and callers may also pass the request itself or its JSON. */
export function triggerRequestOf(payload: unknown): Record<string, unknown> | undefined {
  const value = asRecord(parsed(payload));
  if (!value) return undefined;
  if (typeof value["kind"] === "string") return value;
  const parts = value["parts"];
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const request = triggerRequestOf(asRecord(part)?.["text"]);
    if (request) return request;
  }
  return undefined;
}
