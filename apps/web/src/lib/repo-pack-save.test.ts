import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import type { Transport } from "@intx/hub-client";
import { fakeHub, type FakeHub } from "./fake-hub.ts";
import { fromPack } from "./pack-draft.ts";
import { openSession, saveDraft, unsavedChanges } from "./repo-pack-save.ts";
import { transportRepoPackStore } from "./repo-pack-store.ts";

const repo = "acme/widgets";
const title = "check-pack/acme/widgets";
const config = { corbitsTriage: { repos: [{ name: repo, connected: true, installationId: 9 }] } };

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

function writes(hub: FakeHub): string[] {
  return hub.requests.filter((line) => !line.startsWith("GET "));
}

function repoRow(hub: FakeHub): Record<string, unknown> {
  return (hub.config.corbitsTriage as { repos: Array<Record<string, unknown>> }).repos[0]!;
}

describe("saving the repository pack", () => {
  test("a pack that changed on the hub since it was loaded sets stale and skips the config write", async () => {
    const hub = fakeHub([{ id: "art_1", title, content: JSON.stringify(recommendedPack(repo)), version: 1, updatedAt: 1 }], config);
    const store = transportRepoPackStore(hub.transport, "t");
    const session = openSession(repo, await store.load(repo, false));
    hub.artifacts[0]!.version = 2;
    hub.requests.length = 0;
    const { session: after, failure } = await saveDraft(store, repo, session, fromPack(emptyPack(repo), session.saved.policy));
    expect(failure?.stale).toBe(true);
    expect(after).toBe(session);
    expect(writes(hub)).toEqual(["POST /api/tenants/t/artifacts/art_1/versions"]);
  });

  test("a failed config write after the pack write leaves it unlinked; saving again redoes only that write", async () => {
    const hub = fakeHub([], config);
    const store = transportRepoPackStore(failingPatchOnce(hub.transport), "t");
    const session = openSession(repo, await store.load(repo, false));
    const draft = fromPack(recommendedPack(repo), session.saved.policy);
    const first = await saveDraft(store, repo, session, draft);
    expect(first.failure?.message).toStartWith("The policy is saved and in effect, but could not be linked");
    expect(first.session.unlinked).toBe(true);
    expect(hub.artifacts).toHaveLength(1);
    hub.requests.length = 0;
    const second = await saveDraft(store, repo, first.session, draft);
    expect(second.failure).toBeNull();
    expect(second.session.unlinked).toBe(false);
    expect(writes(hub)).toEqual(["PATCH /api/tenants/t"]);
    expect(repoRow(hub)).toMatchObject({ checkPack: { name: title } });
  });

  test("a save with no changes writes nothing", async () => {
    const hub = fakeHub([{ id: "art_1", title, content: JSON.stringify(recommendedPack(repo)), version: 1, updatedAt: 1 }], config);
    const store = transportRepoPackStore(hub.transport, "t");
    const session = openSession(repo, await store.load(repo, false));
    hub.requests.length = 0;
    expect(await saveDraft(store, repo, session, session.saved)).toEqual({ session, renamed: {}, failure: null });
    expect(hub.requests).toEqual([]);
  });

  test("a corrupt pack is replaced on save even with nothing edited", async () => {
    const hub = fakeHub([{ id: "art_1", title, content: "not a pack", version: 1, updatedAt: 1 }], config);
    const store = transportRepoPackStore(hub.transport, "t");
    const session = openSession(repo, await store.load(repo, false));
    expect(session.corrupt).not.toBeNull();
    hub.requests.length = 0;
    const { session: after, failure } = await saveDraft(store, repo, session, session.saved);
    expect(failure).toBeNull();
    expect(after.corrupt).toBeNull();
    expect(writes(hub)).toEqual(["POST /api/tenants/t/artifacts/art_1/versions", "PATCH /api/tenants/t"]);
  });

  test("one config write carries the pack pointer and the triage switch", async () => {
    const hub = fakeHub([], config);
    const store = transportRepoPackStore(hub.transport, "t");
    const session = openSession(repo, await store.load(repo, false));
    const policy = { enabled: true };
    const { failure } = await saveDraft(store, repo, session, fromPack(recommendedPack(repo), policy));
    expect(failure).toBeNull();
    expect(writes(hub)).toEqual(["POST /api/tenants/t/artifacts", "PATCH /api/tenants/t"]);
    expect(repoRow(hub)).toEqual({ name: repo, connected: true, installationId: 9, ...policy, checkPack: { name: title, id: "art_1" } });
  });

  test("the saved copy takes on the normalised pack while the draft keeps what was typed, so nothing reads as unsaved", async () => {
    const hub = fakeHub([], config);
    const store = transportRepoPackStore(hub.transport, "t");
    const session = openSession(repo, await store.load(repo, false));
    const pack = recommendedPack(repo);
    const untidy = { ...pack, checks: { ...pack.checks, "no-forbidden-paths": { enabled: true, forbiddenGlobs: [" dist/** "] } } };
    const policy = session.saved.policy;
    const draft = fromPack(untidy, policy);
    const { session: after, failure } = await saveDraft(store, repo, session, draft);
    expect(failure).toBeNull();
    expect(after.saved.pack.checks["no-forbidden-paths"]).toEqual({ enabled: true, forbiddenGlobs: ["dist/**"] });
    expect(draft.pack.checks["no-forbidden-paths"]?.forbiddenGlobs).toEqual([" dist/** "]);
    expect(unsavedChanges(after, draft)).toBe(0);
  });
});
