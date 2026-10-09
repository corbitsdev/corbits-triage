import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { alreadyWritten, writeCheckPack } from "./check-pack.ts";
import { fakeHub } from "./fake-hub.ts";
import { loadRepoCheckPack, startBacklogTriage, startPullRequestTriage, type StoredCheckPack } from "./hub-api.ts";

const title = "check-pack/acme/widgets";
const config = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } };
const recommended = recommendedPack("acme/widgets");

describe("check-pack recovery", () => {
  test("an unreadable newest pack loads as corrupt and is replaced in place, never created beside", async () => {
    const hub = fakeHub([{ id: "c", title, content: "{\"not\":\"a pack\"}", version: 1, updatedAt: 1 }], config);
    const opened = await loadRepoCheckPack(hub.transport, "t", "acme/widgets");
    expect(opened).toEqual({ kind: "corrupt", id: "c", version: 1 });
    const replaced = await writeCheckPack(hub.transport, "t", "acme/widgets", recommended, { id: "c", version: 1 });
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

  test("a pack written but not linked is reused when saved again unchanged, and rewritten when it changed", () => {
    const written: StoredCheckPack = { kind: "pack", id: "art_1", version: 1, pack: recommended };
    expect(alreadyWritten(written, recommended)).toBe(written);
    expect(alreadyWritten(written, emptyPack("acme/widgets"))).toBeNull();
    expect(alreadyWritten(null, recommended)).toBeNull();
  });
});
