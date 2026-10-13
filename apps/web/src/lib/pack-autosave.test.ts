import { expect, test } from "bun:test";
import { readCheckPack, recommendedPack } from "@corbits/triage-contracts";
import { fakeHub } from "./fake-hub.ts";
import { createAutosave } from "./pack-autosave.ts";
import { setCatalogCheck, setList } from "./pack-draft.ts";
import { openSession } from "./repo-pack-save.ts";
import { transportRepoPackStore } from "./repo-pack-store.ts";

const repo = "acme/widgets";
const config = { corbitsTriage: { repos: [{ name: repo, connected: true, installationId: 9, enabled: true, checkPack: { name: `check-pack/${repo}` } }] } };

test("edits made around a conflicting save are replayed onto the other writer's pack; unfinished steps wait and typed text keeps its spacing", async () => {
  const stored = recommendedPack(repo);
  const hub = fakeHub([{ id: "art_1", title: `check-pack/${repo}`, content: JSON.stringify(stored), version: 1, updatedAt: 1 }], config);
  const store = transportRepoPackStore(hub.transport, "t");
  const session = openSession(repo, await store.load(repo, false));
  const autosave = createAutosave({ store, repo, session, delayMs: 60_000, changed: () => undefined, saved: async () => undefined });

  // Someone else switches CI off after this panel loaded.
  hub.artifacts[0]!.content = JSON.stringify({ ...stored, checks: { ...stored.checks, "ci-green": { enabled: false } } });
  hub.artifacts[0]!.version = 2;

  autosave.edit((draft) => setList(draft, "pass", [...draft.pack.actions.pass, { do: "comment" as const, target: { body: "Thanks!  " } }]));
  const saving = autosave.flush();
  autosave.edit((draft) => setCatalogCheck(draft, session.saved.pack, "max-files-changed", { maxFiles: 10 }));
  autosave.edit((draft) => setList(draft, "fail", [...draft.pack.actions.fail, { do: "comment" as const, target: { body: "" } }]));
  await saving;
  await autosave.flush();

  const saved = readCheckPack(JSON.parse(hub.artifacts[0]!.content));
  expect(saved.checks["ci-green"]).toEqual({ enabled: false });
  expect(saved.checks["max-files-changed"]?.maxFiles).toBe(10);
  expect(saved.actions.pass).toEqual([{ do: "approve" }, { do: "comment", target: { body: "Thanks!" } }]);
  expect(saved.actions.fail).toEqual([]);

  const { draft, error } = autosave.state();
  expect(error).toBe("");
  expect(draft.pack.actions.pass[1]).toEqual({ do: "comment", target: { body: "Thanks!  " } });
  expect(draft.pack.actions.fail).toEqual([{ do: "comment", target: { body: "" } }]);
});

test("a save held back by an unfinished draft does not stop the next one", async () => {
  const hub = fakeHub([], { corbitsTriage: { repos: [{ name: repo, connected: true, installationId: 9 }] } });
  const store = transportRepoPackStore(hub.transport, "t");
  const session = openSession(repo, await store.load(repo, false));
  const autosave = createAutosave({ store, repo, session, delayMs: 60_000, changed: () => undefined, saved: async () => undefined });

  autosave.edit((draft) => ({ ...draft, policy: { ...draft.policy, enabled: true } }));
  await autosave.flush();
  expect(hub.artifacts).toEqual([]);

  autosave.edit((draft) => setCatalogCheck(draft, session.saved.pack, "ci-green", { enabled: true }));
  await autosave.flush();
  expect(readCheckPack(JSON.parse(hub.artifacts[0]!.content)).checks["ci-green"]).toEqual({ enabled: true });
  expect(autosave.state().session.saved.policy.enabled).toBe(true);
});
