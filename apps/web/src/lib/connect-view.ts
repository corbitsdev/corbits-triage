// SPDX-License-Identifier: GPL-2.0-only

type EventLike = { type?: unknown; body?: unknown };
type LogLike = { events?: EventLike[] };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

/** Accept the two PEM envelopes GitHub emits for App private keys. */
export function isPrivateKeyPem(value: string): boolean {
  const pem = value.trim();
  return /^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(pem) ||
    /^-----BEGIN RSA PRIVATE KEY-----\n[\s\S]+\n-----END RSA PRIVATE KEY-----$/.test(pem);
}

function fillRandom(bytes: Uint8Array): void {
  crypto.getRandomValues(bytes as unknown as Uint8Array<ArrayBuffer>);
}

export function generateWebhookSecret(fill: (bytes: Uint8Array) => void = fillRandom): string {
  const bytes = new Uint8Array(32);
  fill(bytes);
  if (bytes.length !== 32) throw new Error("Webhook secret generator must return 32 bytes");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** True only after the hub log records a GitHub PR payload for this repository. */
export function hasVerifiedWebhookDelivery(logs: LogLike[], repo: string): boolean {
  function isPrDelivery(event: EventLike): boolean {
    if (event.type !== "RunStarted") return false;
    const trigger = record(record(event.body).trigger);
    const payload = payloadRecord(trigger.payload);
    return payload.kind === "pr" && payload.repo === repo;
  }
  return logs.some((log) => (log.events ?? []).some(isPrDelivery));
}

/** A confidence-bearing result proves inference contributed; credentials alone do not. */
export function hasObservedInference(items: Array<{ confidence: number | null }>): boolean {
  return items.some((item) => typeof item.confidence === "number" && Number.isFinite(item.confidence));
}

export async function pollUntil(
  ready: () => Promise<boolean>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 24;
  const delayMs = options.delayMs ?? 500;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await ready()) return true;
    if (attempt < attempts - 1 && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
