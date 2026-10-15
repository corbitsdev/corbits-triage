// The X-Hub-Signature scheme as @corbits/webhooks verifies it, for the hub's own bridges until they move onto it.
import { createHmac, timingSafeEqual } from "node:crypto";

/** `sha256=` and the hex HMAC-SHA256 of the raw body, compared in constant time. */
export function verifyXHubSignature(secret: string, signature: string | null, body: string): boolean {
  if (secret === "" || !signature) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
