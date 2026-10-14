import { expect, test } from "bun:test";
import { readCheckPack, recommendedPack, type CheckPack, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import { fakeHub, type FakeHub } from "./fake-hub.ts";
import { createAutosave, type Autosave } from "./pack-autosave.ts";
import { freshStepId, setCatalogCheck, setSteps, stepEntries, type RepoDraft } from "./pack-draft.ts";
import { openSession, saveDraft, type PackSession } from "./repo-pack-save.ts";
import { transportRepoPackStore } from "./repo-pack-store.ts";

const repo = "acme/widgets";
const title = `check-pack/${repo}`;

function append(draft: RepoDraft, list: VerdictWord, step: Step, id = freshStepId()): RepoDraft {
  return setSteps(draft, list, [...stepEntries(draft, list), { id, step }]);
}

async function open(stored: CheckPack | null): Promise<{ hub: FakeHub; session: PackSession; autosave: Autosave }> {
  const linked = stored ? { enabled: true, checkPack: { name: title } } : {};
  const hub = fakeHub(stored ? [{ id: "art_1", title, content: JSON.stringify(stored), version: 1, updatedAt: 1 }] : [], { corbitsTriage: { repos: [{ name: repo, connected: true, installationId: 9, ...linked }] } });
  const store = transportRepoPackStore(hub.transport, "t");
  const session = openSession(repo, await store.load(repo, false));
  const autosave = createAutosave({
    session,
    delayMs: 60_000,
    write: (current, draft) => saveDraft(store, repo, current, draft),
    reread: async () => openSession(repo, await store.load(repo, true)),
    changed: () => undefined,
    afterSave: async () => undefined,
    failed: () => undefined,
  });
  return { hub, session, autosave };
}

/** Another writer saves over the pack this panel loaded. */
function writeElsewhere(hub: FakeHub, change: (pack: CheckPack) => CheckPack) {
  const row = hub.artifacts[0]!;
  row.content = JSON.stringify(change(readCheckPack(JSON.parse(row.content))));
  row.version += 1;
}

function stored(hub: FakeHub): CheckPack {
  return readCheckPack(JSON.parse(hub.artifacts[0]!.content));
}

test("edits made around a conflicting save land on the other writer's pack; typed text keeps its spacing", async () => {
  const { hub, session, autosave } = await open(recommendedPack(repo));
  writeElsewhere(hub, (pack) => ({ ...pack, checks: { ...pack.checks, "ci-green": { enabled: false } } }));

  autosave.edit((draft) => append(draft, "pass", { do: "comment", target: { body: "Thanks!  " } }));
  const saving = autosave.flush();
  autosave.edit((draft) => setCatalogCheck(draft, session.saved.pack, "max-files-changed", { maxFiles: 10 }));
  await saving;
  await autosave.flush();

  const saved = stored(hub);
  expect(saved.checks["ci-green"]).toEqual({ enabled: false });
  expect(saved.checks["max-files-changed"]?.maxFiles).toBe(10);
  expect(saved.actions.pass).toEqual([{ do: "approve" }, { do: "comment", target: { body: "Thanks!" } }]);
  expect(autosave.state().draft.pack.actions.pass[1]).toEqual({ do: "comment", target: { body: "Thanks!  " } });
});

test("an unfinished step survives another writer's save and is written once it is filled", async () => {
  const { hub, autosave } = await open(recommendedPack(repo));
  const id = freshStepId();
  autosave.edit((draft) => append(draft, "fail", { do: "comment", target: { body: "" } }, id));
  await autosave.flush();
  expect(stored(hub).actions.fail).toEqual([]);

  writeElsewhere(hub, (pack) => ({ ...pack, checks: { ...pack.checks, docs: { enabled: false } } }));
  autosave.edit((draft) => setSteps(draft, "fail", stepEntries(draft, "fail").map((entry) => (entry.id === id ? { id, step: { do: "comment", target: { body: "Split it." } } } : entry))));
  await autosave.flush();

  expect(stored(hub).actions.fail).toEqual([{ do: "comment", target: { body: "Split it." } }]);
  expect(stored(hub).checks.docs).toEqual({ enabled: false });
});

test("a step the other writer added stays when this panel edits a step it had", async () => {
  const { hub, session, autosave } = await open(recommendedPack(repo));
  writeElsewhere(hub, (pack) => ({ ...pack, actions: { ...pack.actions, pass: [{ do: "close" }, ...pack.actions.pass] } }));

  const [approve] = stepEntries(session.saved, "pass");
  autosave.edit((draft) => setSteps(draft, "pass", stepEntries(draft, "pass").map((entry) => (entry.id === approve!.id ? { id: entry.id, step: { do: "merge" } } : entry))));
  await autosave.flush();

  expect(stored(hub).actions.pass).toEqual([{ do: "close" }, { do: "merge" }]);
});

test("a save held back by an unfinished draft does not stop the next one, and a new rule is saved under an id from its text", async () => {
  const { hub, session, autosave } = await open(null);

  autosave.edit((draft) => ({ ...draft, policy: { ...draft.policy, enabled: true } }));
  await autosave.flush();
  expect(hub.artifacts).toEqual([]);

  autosave.edit((draft) => setCatalogCheck(draft, session.saved.pack, "ci-green", { enabled: true }));
  autosave.edit((draft) => ({ ...draft, pack: { ...draft.pack, custom: [{ id: "is-it-true", name: "the title says what changed", group: "pull-request", kind: "model", shape: "is-true", claim: "the title says what changed" }] } }));
  await autosave.flush();
  expect(stored(hub).checks["ci-green"]).toEqual({ enabled: true });
  expect(stored(hub).custom.map((row) => row.id)).toEqual(["the-title-says-what-changed"]);
  expect(autosave.state().draft.pack.custom.map((row) => row.id)).toEqual(["the-title-says-what-changed"]);
  expect(autosave.state().session.saved.policy.enabled).toBe(true);
});

function editStep(draft: RepoDraft, id: string, step: Step): RepoDraft {
  return setSteps(draft, "pass", stepEntries(draft, "pass").map((entry) => (entry.id === id ? { id, step } : entry)));
}

test("a step the other writer changed is kept beside this panel's edit of another step", async () => {
  const pack = recommendedPack(repo);
  const both: CheckPack = { ...pack, actions: { ...pack.actions, pass: [{ do: "approve" }, { do: "close" }] } };

  const first = await open(both);
  writeElsewhere(first.hub, (stored) => ({ ...stored, actions: { ...stored.actions, pass: [{ do: "request-changes" }] } }));
  const [approve] = stepEntries(first.session.saved, "pass");
  first.autosave.edit((draft) => editStep(draft, approve!.id, { do: "merge" }));
  await first.autosave.flush();
  expect(stored(first.hub).actions.pass).toEqual([{ do: "request-changes" }, { do: "merge" }]);

  const second = await open(both);
  writeElsewhere(second.hub, (stored) => ({ ...stored, actions: { ...stored.actions, pass: [{ do: "comment", target: { body: "Thanks." } }, { do: "approve" }] } }));
  const [, close] = stepEntries(second.session.saved, "pass");
  second.autosave.edit((draft) => editStep(draft, close!.id, { do: "merge" }));
  await second.autosave.flush();
  expect(stored(second.hub).actions.pass).toEqual([{ do: "comment", target: { body: "Thanks." } }, { do: "approve" }, { do: "merge" }]);
});

test("a rule saved for the first time never takes the id of a rule still unfinished in the draft", async () => {
  const { hub, autosave } = await open(recommendedPack(repo));
  const unfinished: CustomCheck = { id: "the-title", name: "Is it true", group: "pull-request", kind: "model", shape: "is-true", claim: "" };
  const finished: CustomCheck = { id: "is-it-true", name: "the title", group: "pull-request", kind: "model", shape: "is-true", claim: "the title" };
  autosave.edit((draft) => ({ ...draft, pack: { ...draft.pack, custom: [unfinished, finished] } }));
  await autosave.flush();

  const ids = autosave.state().draft.pack.custom.map((row) => row.id);
  expect(ids[0]).toBe("the-title");
  expect(ids[1]).not.toBe("the-title");
  expect(stored(hub).custom.map((row) => row.id)).toEqual([ids[1]]);
});
