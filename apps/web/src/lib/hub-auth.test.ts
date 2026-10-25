import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { getAuthMethods } from "./hub-auth.ts";

afterEach(() => mock.restore());

test("sign-in options from an unreachable hub say only that", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(getAuthMethods()).rejects.toThrow(/^The hub is unreachable\.$/);
});

test("sign-in options the hub answers without a body are malformed", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html></html>", { status: 200 }));
  await expect(getAuthMethods()).rejects.toThrow(/^The hub returned malformed sign-in options\.$/);
});
