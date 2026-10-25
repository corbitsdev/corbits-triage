import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createHubTransport } from "./hub-transport.ts";

afterEach(() => mock.restore());

test("a hub error without a message reads as a sentence", async () => {
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 502 }));
  await expect(createHubTransport().fetch("GET", "/api/tenants")).rejects.toThrow(/^The hub answered with an error \(HTTP 502\)\.$/);
});

test("an unreachable hub says only that", async () => {
  spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(createHubTransport().fetch("GET", "/api/tenants")).rejects.toThrow(/^The hub is unreachable\.$/);
});
