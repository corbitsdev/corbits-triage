import { afterEach, beforeEach, expect, test } from "bun:test";
import { createInMemoryGrantStore } from "@intx/authz";
import { configureSync, getConfig, resetSync } from "@intx/log";
import { guardedApp } from "./test-app.js";

type Line = { category: readonly string[]; properties: Record<string, unknown> };

let lines: Line[] = [];
let previous: ReturnType<typeof getConfig>;

beforeEach(() => {
  lines = [];
  previous = getConfig();
  configureSync({
    reset: true,
    sinks: { capture: (record) => lines.push(record) },
    loggers: [{ category: ["hub", "requests"], sinks: ["capture"], lowestLevel: "debug" }, { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" }],
  });
});

afterEach(() => {
  resetSync();
  if (previous) configureSync(previous);
});

const signedIn = async () => ({ user: { id: "user-1" } }) as never;

test("a request from outside the portal is refused", async () => {
  const app = guardedApp({} as never, signedIn, createInMemoryGrantStore([]), {});
  const res = await app.request("/api/integrations/workflow-deploy/tenant-1", { method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.example" }, body: "{}" });
  expect({ status: res.status, body: await res.json() }).toEqual({ status: 403, body: { error: { code: "forbidden", message: "This request did not come from the portal." } } });
});

test("the manifest callback's code and state never reach the request log", async () => {
  const app = guardedApp({} as never, signedIn, createInMemoryGrantStore([]), { manifest: { start: async () => new Response(), callback: async () => new Response(null, { status: 400 }) } });
  const res = await app.request("/api/integrations/github-manifest/callback?state=S3CRET_STATE&code=ONE_TIME_CODE");
  await res.text();
  expect(lines).toHaveLength(1);
  expect(JSON.stringify(lines)).not.toMatch(/S3CRET_STATE|ONE_TIME_CODE/);
});
