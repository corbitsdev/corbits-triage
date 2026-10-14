/** The two PEM envelopes GitHub emits. */
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
