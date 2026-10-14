import { describe, expect, test } from "bun:test";
import { isPrivateKeyPem } from "./connect-view.ts";

describe("GitHub App browser trust boundary", () => {
  test("accepts GitHub App PKCS#8 and RSA PEM files only", () => {
    expect(isPrivateKeyPem("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(true);
    expect(isPrivateKeyPem("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe(true);
    expect(isPrivateKeyPem("client-secret")).toBe(false);
    expect(isPrivateKeyPem("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----")).toBe(false);
  });

});
