import { describe, expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import type { Transport } from "@intx/hub-client";
import { alreadyWritten, linkCheckPack, writeCheckPack } from "./check-pack.ts";
import { fakeHub } from "./fake-hub.ts";
import { loadRepoCheckPack } from "./hub-api.ts";

const config = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } };
const pack = recommendedPack("acme/widgets");

function failingPatchOnce(inner: Transport): Transport {
  let failed = false;
  return {
    subscribe: inner.subscribe,
    async fetch(method, path, body) {
      if (method === "PATCH" && !failed) {
        failed = true;
        throw new Error("network down");
      }
      return inner.fetch(method, path, body);
    },
  } as Transport;
}

describe("written pack whose link failed", () => {
  test("the page's path (write, link fails, alreadyWritten, link) links the one artifact", async () => {
    const hub = fakeHub([], config);
    const transport = failingPatchOnce(hub.transport);
    const written = await writeCheckPack(transport, "t", "acme/widgets", pack, null);
    await expect(linkCheckPack(transport, "t", "acme/widgets", "human-approved")).rejects.toThrow("network down");
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/widgets")).toEqual(written);
    const reuse = alreadyWritten(written, pack);
    expect(reuse).toBe(written);
    await linkCheckPack(transport, "t", "acme/widgets", "human-approved");
    expect(hub.artifacts).toHaveLength(1);
    const repos = (hub.config.corbitsTriage as { repos: Array<Record<string, unknown>> }).repos;
    expect(repos[0]).toMatchObject({ checkPack: { name: "check-pack/acme/widgets" } });
  });
});
