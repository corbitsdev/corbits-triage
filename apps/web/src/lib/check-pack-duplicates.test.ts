import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { listCheckPackTitles, saveCheckPack, StaleCheckPackError } from "./check-pack.ts";
import { fakeHub, type FakeArtifact } from "./fake-hub.ts";
import { findArtifactByTitle, loadRepoCheckPack } from "./hub-api.ts";

const title = "check-pack/acme/widgets";
const newer = recommendedPack("acme/widgets");
const older = emptyPack("acme/widgets");

function row(id: string, at: number, extra: Partial<FakeArtifact> = {}): FakeArtifact {
  return { id, title, content: "{}", version: 1, updatedAt: at, ...extra };
}

describe("duplicate check-pack titles", () => {
  test("the direct read resolves to the newest artifact", async () => {
    const hub = fakeHub([row("old", 1, { content: JSON.stringify(older) }), row("new", 2, { content: JSON.stringify(newer) })]);
    expect((await findArtifactByTitle(hub.transport, "t", title))?.id).toBe("new");
    expect(await loadRepoCheckPack(hub.transport, "t", "acme/widgets")).toEqual({ id: "new", version: 1, pack: newer });
  });

  test("findArtifactByTitle stops once the exact title is on page one", async () => {
    const hub = fakeHub([row("a", 300), ...Array.from({ length: 250 }, (_, i) => row(`n${i}`, i, { title: `${title}${i}` }))]);
    await findArtifactByTitle(hub.transport, "t", title);
    expect(hub.requests).toHaveLength(1);
  });

  test("the title listing and the direct read page past substring-only matches to the exact title", async () => {
    const hub = fakeHub([row("target", 0), ...Array.from({ length: 150 }, (_, i) => row(`n${i}`, i + 1, { title: `${title}-${i}` }))]);
    expect((await findArtifactByTitle(hub.transport, "t", title))?.id).toBe("target");
    expect((await listCheckPackTitles(hub.transport, "t")).has(title)).toBe(true);
  });

  test("a draft loaded from one artifact cannot save while a newer one carries the title", async () => {
    const hub = fakeHub([row("X", 1, { content: JSON.stringify(newer) })]);
    const opened = await loadRepoCheckPack(hub.transport, "t", "acme/widgets");
    expect(opened).toMatchObject({ id: "X", version: 1 });
    hub.artifacts.push(row("Y", 2, { content: JSON.stringify(older) }));
    const save = saveCheckPack(hub.transport, "t", "acme/widgets", older, { loaded: opened });
    await expect(save).rejects.toBeInstanceOf(StaleCheckPackError);
    expect(hub.artifacts.map((item) => item.version)).toEqual([1, 1]);
  });
});
