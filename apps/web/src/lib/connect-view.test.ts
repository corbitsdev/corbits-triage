import { describe, expect, test } from "bun:test";
import { generateWebhookSecret, isPrivateKeyPem } from "./connect-view.ts";

describe("GitHub App browser trust boundary", () => {
  test("accepts GitHub App PKCS#8 and RSA PEM files only", () => {
    expect(isPrivateKeyPem("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(true);
    expect(isPrivateKeyPem("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(true);
    expect(isPrivateKeyPem("client-secret")).toBe(false);
    expect(isPrivateKeyPem("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toBe(false);
  });

  test("generates a 32-byte webhook secret without persistence", () => {
    const secret = generateWebhookSecret((bytes) => {
      bytes.forEach((_, index) => { bytes[index] = index; });
      return bytes;
    });
    expect(secret).toBe("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    expect(secret).toHaveLength(64);
  });
});
