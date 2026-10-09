import { describe, expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { saveCheckPack } from "./check-pack.ts";
import { fakeHub } from "./fake-hub.ts";
import { loadRepoCheckPack, startBacklogTriage, startPullRequestTriage } from "./hub-api.ts";

const title = "check-pack/acme/widgets";
const config = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } };
const recommended = recommendedPack("acme/widgets");

describe("check-pack recovery", () => {
  test("an unreadable newest pack loads as corrupt and is replaced in place, never created beside", async () => {
    const hub = fakeHub([{ id: "c", title, content: "{\"not\":\"a pack\"}", version: 1, updatedAt: 1 }], config);
    const opened = await loadRepoCheckPack(hub.transport, "t", "acme/widgets");
    expect(opened).toEqual({ kind: "corrupt", id: "c", version: 1 });
    const replaced = await saveCheckPack(hub.transport, "t", "acme/widgets", recommended, { loaded: { id: "c", version: 1 } });
    expect(replaced).toEqual({ kind: "pack", id: "c", version: 2, pack: recommended });
    expect(hub.artifacts).toHaveLength(1);
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/widgets")).toEqual(replaced);
  });

  test("triage will not start on a corrupt pack", async () => {
    const enabled = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true, enabled: true }] } };
    const hub = fakeHub([{ id: "c", title, content: "{\"not\":\"a pack\"}", version: 1, updatedAt: 1 }], enabled);
    const unreadable = /unreadable/;
    await expect(startBacklogTriage(hub.transport, "t", "acme/widgets")).rejects.toThrow(unreadable);
    await expect(startPullRequestTriage(hub.transport, "t", JSON.stringify({ repo: "acme/widgets", number: 1 }))).rejects.toThrow(unreadable);
    expect(hub.requests.filter((line) => line.includes("/workflows"))).toEqual([]);
  });
});
