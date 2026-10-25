import { describe, expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { writeCheckPack } from "./check-pack.ts";
import { fakeHub } from "./fake-hub.ts";
import { loadRepoCheckPack } from "./hub-api.ts";

const title = "check-pack/acme/widgets";
const config = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } };
const recommended = recommendedPack("acme/widgets");

describe("check-pack recovery", () => {
  test("an unreadable pack loads as corrupt and is replaced in place, never created beside", async () => {
    const hub = fakeHub([{ id: "c", title, content: "{\"not\":\"a pack\"}", version: 1, updatedAt: 1 }], config);
    const opened = await loadRepoCheckPack(hub.transport, "t", "acme/widgets", "github");
    expect(opened).toEqual({ kind: "corrupt", id: "c", version: 1, reason: "kind must be corbits.triage.check-pack." });
    const replaced = await writeCheckPack(hub.transport, "t", "acme/widgets", "github", recommended, { id: "c", version: 1 });
    expect(replaced).toEqual({ kind: "pack", id: "c", version: 2, pack: recommended });
    expect(hub.artifacts).toHaveLength(1);
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/widgets", "github")).toEqual({ ...replaced, automatic: [], decide: [], mergeRisks: [] });
  });
});
