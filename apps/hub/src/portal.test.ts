import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortalHandler, withPortalCors } from "./portal.js";

const PORTAL = "https://triage.example.com";

async function ok(): Promise<Response> {
  return Response.json({ ok: true });
}

describe("portal CORS", () => {
  const handler = withPortalCors(PORTAL, ok);

  test("allows only the configured origin", async () => {
    const allowed = await handler(new Request("https://hub.example.com/api/me", { headers: { origin: PORTAL } }));
    expect(allowed.headers.get("access-control-allow-origin")).toBe(PORTAL);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

    const foreign = await handler(new Request("https://hub.example.com/api/me", { headers: { origin: "https://evil.example" } }));
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("portal static files", () => {
  test("never serves files outside the portal folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portal-"));
    writeFileSync(join(dir, "index.html"), "INDEX");
    writeFileSync(join(tmpdir(), "outside-portal.txt"), "SECRET");
    const serve = createPortalHandler(dir);
    const escaped = await serve(new Request(`https://hub.example.com/%2e%2e%2foutside-portal.txt`));
    expect(await escaped.text()).toBe("INDEX");
  });
});
