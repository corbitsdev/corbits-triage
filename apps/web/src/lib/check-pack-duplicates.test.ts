import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { ExtendedPolicyError, listCheckPacks, StaleCheckPackError, writeCheckPack } from "./check-pack.ts";
import { fakeHub, type FakeArtifact } from "./fake-hub.ts";
import { findArtifactByTitle, loadRepoCheckPack } from "./hub-api.ts";

const title = "check-pack/acme/widgets";
const newer = recommendedPack("acme/widgets");
const older = emptyPack("acme/widgets");

function row(id: string, at: number, extra: Partial<FakeArtifact> = {}): FakeArtifact {
  return { id, title, content: "{}", version: 1, updatedAt: at, ...extra };
}

describe("duplicate check-pack titles", () => {
  test("findArtifactByTitle stops once the exact title is on page one", async () => {
    const hub = fakeHub([row("a", 300), ...Array.from({ length: 250 }, (_, i) => row(`n${i}`, i, { title: `${title}${i}` }))]);
    await findArtifactByTitle(hub.transport, "t", title);
    expect(hub.requests).toHaveLength(1);
  });

  test("the title listing and the direct read page past substring-only matches to the exact title", async () => {
    const hub = fakeHub([row("target", 0), ...Array.from({ length: 150 }, (_, i) => row(`n${i}`, i + 1, { title: `${title}-${i}` }))]);
    expect((await findArtifactByTitle(hub.transport, "t", title))?.id).toBe("target");
    expect((await listCheckPacks(hub.transport, "t")).has(title)).toBe(true);
  });

  test("a draft saves onto the artifact triage reads, and is refused once triage reads another", async () => {
    const hub = fakeHub([row("X", 1, { content: JSON.stringify(newer) })]);
    const opened = await loadRepoCheckPack(hub.transport, "t", "acme/widgets", "github");
    expect(opened).toMatchObject({ id: "X", version: 1 });
    const saved = await writeCheckPack(hub.transport, "t", "acme/widgets", "github", older, { id: "X", version: 1 });
    expect(saved).toMatchObject({ id: "X", version: 2 });
    hub.artifacts.push(row("Y", 9, { content: JSON.stringify(older) }));
    await expect(writeCheckPack(hub.transport, "t", "acme/widgets", "github", newer, saved)).rejects.toBeInstanceOf(StaleCheckPackError);
    expect(hub.artifacts.map((item) => item.version)).toEqual([2, 1]);
  });

  test("a policy that extends a workspace policy is not saved over", async () => {
    const hub = fakeHub([row("O", 1, { version: 4 })]);
    hub.policies["acme/widgets"] = { status: "ok", pack: newer, source: { repo: { id: "O", version: 4 }, shared: { id: "S", version: 1 } }, automatic: [], decide: [], mergeRisks: [] };
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/widgets", "github")).toEqual({ kind: "pack", id: "O", version: 4, pack: newer, automatic: [], decide: [], mergeRisks: [], shared: { id: "S", version: 1 } });
    await expect(writeCheckPack(hub.transport, "t", "acme/widgets", "github", older, { id: "O", version: 4 })).rejects.toBeInstanceOf(ExtendedPolicyError);
    expect(hub.artifacts.map((item) => item.version)).toEqual([4]);
  });
});
