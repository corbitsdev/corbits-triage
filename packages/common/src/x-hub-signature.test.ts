import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyXHubSignature } from "./x-hub-signature.js";

const body = '{"action":"opened"}';
const signed = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;

test("verifyXHubSignature accepts the hex HMAC of the raw body and nothing else", () => {
  expect(verifyXHubSignature("s3cret", signed, body)).toBe(true);
  expect(verifyXHubSignature("other", signed, body)).toBe(false);
  expect(verifyXHubSignature("s3cret", signed.slice("sha256=".length), body)).toBe(false);
  expect(verifyXHubSignature("s3cret", null, body)).toBe(false);
  expect(verifyXHubSignature("", signed, body)).toBe(false);
});
