import { afterEach, describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { connectGithubApp, GITHUB_MANIFEST_URL, postGithubManifest, saveExistingGithubApp, type ManifestStart } from "./github-manifest.ts";
import type { HubCredential } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";

const realFetch = globalThis.fetch;

describe("GitHub App manifest browser handoff", () => {
  afterEach(function restoreFetch() {
    globalThis.fetch = realFetch;
  });

  test("posts only the server-issued manifest and opaque state to GitHub", () => {
    const inputs: Array<{ type?: string; name: string; value: string }> = [];
    const form = {
      method: "", action: "", append: (input: { name: string; value: string }) => inputs.push(input),
      submit: () => {}, remove: () => {},
    };
    const documentImpl = {
      createElement: (tag: string) => tag === "form" ? form : { type: "", name: "", value: "" },
      body: { append: () => {} },
    } as unknown as Document;
    const start = { manifest: { redirect_url: "https://hub.example/api/integrations/github-manifest/callback" }, state: "opaque" } as ManifestStart;
    postGithubManifest(start, documentImpl);
    expect(form.action).toBe(GITHUB_MANIFEST_URL);
    expect(inputs).toEqual([
      { type: "hidden", name: "manifest", value: JSON.stringify(start.manifest) },
      { type: "hidden", name: "state", value: "opaque" },
    ]);
    expect(JSON.stringify(inputs)).not.toContain("privateKey");
    expect(JSON.stringify(inputs)).not.toContain("webhook_secret");
  });

  test("existing-App save requires replacement confirmation when canonical credentials exist", async () => {
    const transport: Transport = {
      fetch: async () => {
        throw new Error("must not write until replacement is confirmed");
      },
      subscribe: () => () => {},
    };
    const existing: HubCredential[] = [
      { id: "crd_app", tenantId: "tnt_one", name: "github", type: "other", status: "active", providerId: "prv", createdAt: "2026-03-10T00:00:00.000Z", updatedAt: "2026-03-10T00:00:00.000Z" },
      { id: "crd_hook", tenantId: "tnt_one", name: "github-hook", type: "other", status: "active", providerId: "prv", createdAt: "2026-03-10T00:00:00.000Z", updatedAt: "2026-03-10T00:00:00.000Z" },
    ];
    await expect(saveExistingGithubApp({
      tenantId: "tnt_one",
      appId: "42",
      privateKey: "pem",
      webhookSecret: "hook-secret",
      replace: false,
      credentials: existing,
    }, transport)).rejects.toEqual(expect.objectContaining({ reason: "replacement_confirmation_required" }));
  });

  test("saving the App key reports the HTTP status when the error response is not JSON", async () => {
    globalThis.fetch = async function proxyFailure() {
      return new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    } as unknown as typeof fetch;
    await expect(connectGithubApp(createHubTransport(), "tnt_one", { appId: "42", privateKey: "pem" })).rejects.toThrow("HTTP 502");
  });
});
