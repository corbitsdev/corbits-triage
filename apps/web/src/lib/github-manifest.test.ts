// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import type { Transport } from "@intx/hub-client";
import { GITHUB_MANIFEST_URL, postGithubManifest, saveExistingGithubApp, type ManifestStart } from "./github-manifest.ts";
import type { HubCredential } from "./hub-api.ts";

describe("GitHub App manifest browser handoff", () => {
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
      { id: "crd_app", name: "github", status: "active", providerId: "prv" },
      { id: "crd_hook", name: "github-hook", status: "active", providerId: "prv" },
    ];
    await expect(saveExistingGithubApp({
      tenantId: "tnt_one",
      appId: "42",
      privateKey: "pem",
      webhookSecret: "hook-secret",
      appSlug: "corbits-triage",
      replace: false,
      credentials: existing,
    }, transport)).rejects.toEqual(expect.objectContaining({ reason: "replacement_confirmation_required" }));
  });
});
