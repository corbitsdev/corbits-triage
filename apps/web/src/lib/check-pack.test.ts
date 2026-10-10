import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { listCheckPacks, repoNeedsCheckSetup, StaleCheckPackError, writeCheckPack } from "./check-pack.ts";
import { fakeHub, type FakeArtifact } from "./fake-hub.ts";
import { loadRepoCheckPack } from "./hub-api.ts";

const widgets = recommendedPack("acme/widgets");
const gadgets = recommendedPack("acme/gadgets");
const config = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true }] } };

function row(id: string, title: string, pack: unknown, at: number, version = 1): FakeArtifact {
  return { id, title, content: JSON.stringify(pack), version, updatedAt: at };
}

describe("check-pack client", () => {
  test("the index keeps only check-pack titles, though the hub also matches the prefix in content", async () => {
    const hub = fakeHub([
      row("art_1", "check-pack/acme/widgets", widgets, 1),
      row("art_2", "notes/check-pack/acme/other", {}, 2),
      row("art_3", "check-pack/acme/gadgets", gadgets, 3),
      row("art_4", "notes", "see check-pack/acme/widgets", 4),
    ]);
    expect(new Set((await listCheckPacks(hub.transport, "t")).keys())).toEqual(new Set(["check-pack/acme/widgets", "check-pack/acme/gadgets"]));
  });

  test("a repository's pack is read with its artifact and version; a missing title reads nothing", async () => {
    const hub = fakeHub([row("art_1", "check-pack/acme/widgets", widgets, 1, 3)]);
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/widgets")).toEqual({ kind: "pack", id: "art_1", version: 3, pack: widgets });
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/gadgets")).toBeNull();
  });

  test("a first save creates the pack; later saves version the artifact that was loaded", async () => {
    const hub = fakeHub([], config);
    const pack = emptyPack("acme/widgets");
    const created = await writeCheckPack(hub.transport, "t", "acme/widgets", pack, null);
    expect(created).toEqual({ kind: "pack", id: "art_1", version: 1, pack });
    expect(hub.artifacts[0]).toMatchObject({ title: "check-pack/acme/widgets", content: JSON.stringify(pack), version: 1 });
    const revised = await writeCheckPack(hub.transport, "t", "acme/widgets", widgets, created);
    expect(revised).toEqual({ kind: "pack", id: "art_1", version: 2, pack: widgets });
    expect(hub.requests).toContain("POST /api/tenants/t/artifacts/art_1/versions");
    expect(hub.artifacts).toHaveLength(1);
  });

  test("a save refuses to overwrite a pack that changed, or appeared, since the form was opened", async () => {
    const hub = fakeHub([row("art_1", "check-pack/acme/widgets", widgets, 1, 2)], config);
    const changed = writeCheckPack(hub.transport, "t", "acme/widgets", emptyPack("acme/widgets"), { id: "art_1", version: 1 });
    await expect(changed).rejects.toBeInstanceOf(StaleCheckPackError);
    const unseen = writeCheckPack(hub.transport, "t", "acme/widgets", emptyPack("acme/widgets"), null);
    await expect(unseen).rejects.toBeInstanceOf(StaleCheckPackError);
    expect(hub.artifacts).toHaveLength(1);
    expect(JSON.parse(hub.artifacts[0]!.content)).toEqual(widgets);
  });

  test("repoNeedsCheckSetup is true until a pack pointer exists", () => {
    expect(repoNeedsCheckSetup({ name: "acme/widgets" })).toBe(true);
    expect(repoNeedsCheckSetup({ checkPack: { name: "check-pack/acme/widgets" } })).toBe(false);
  });
});
