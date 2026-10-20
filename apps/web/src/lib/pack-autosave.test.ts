import { expect, test } from "bun:test";
import { readCheckPack, recommendedPack, type CheckPack, type CustomCheck, type Step, type VerdictWord } from "@corbits/triage-contracts";
import { fakeHub, type FakeHub } from "./fake-hub.ts";
import { createAutosave, type Autosave } from "./pack-autosave.ts";
import { freshStepId, setSteps, stepEntries, type RepoDraft } from "./pack-draft.ts";
import { openSession, saveDraft, type PackSession } from "./repo-pack-save.ts";
import { transportRepoPackStore } from "./repo-pack-store.ts";

const repo = "acme/widgets";
const title = `check-pack/${repo}`;

function append(draft: RepoDraft, list: VerdictWord, step: Step, id = freshStepId()): RepoDraft {
  return setSteps(draft, list, [...stepEntries(draft, list), { id, step }]);
}

async function open(stored: CheckPack | null, afterReread?: (hub: FakeHub) => void): Promise<{ hub: FakeHub; session: PackSession; autosave: Autosave }> {
  const linked = stored ? { enabled: true, checkPack: { name: title } } : {};
  const hub = fakeHub(stored ? [{ id: "art_1", title, content: JSON.stringify(stored), version: 1, updatedAt: 1 }] : [], { corbitsTriage: { repos: [{ name: repo, connected: true, installationId: 9, ...linked }] } });
  const store = transportRepoPackStore(hub.transport, "t");
  const session = openSession(repo, await store.load(repo, false));
  async function reread(): Promise<PackSession> {
    const fresh = openSession(repo, await store.load(repo, true));
    afterReread?.(hub);
    return fresh;
  }
  const autosave = createAutosave({
    session,
    delayMs: 60_000,
    write: (current, draft) => saveDraft(store, repo, current, draft),
    reread,
    changed: () => undefined,
    afterSave: async () => undefined,
    failed: () => undefined,
  });
  return { hub, session, autosave };
}

function maxFiles(draft: RepoDraft, value: number): RepoDraft {
  return { ...draft, pack: { ...draft.pack, checks: { ...draft.pack.checks, "max-files-changed": { ...draft.pack.checks["max-files-changed"]!, maxFiles: value } } } };
}

function writeElsewhere(hub: FakeHub, change: (pack: CheckPack) => CheckPack) {
  const row = hub.artifacts[0]!;
  row.content = JSON.stringify(change(readCheckPack(JSON.parse(row.content))));
  row.version += 1;
}

function stored(hub: FakeHub): CheckPack {
  return readCheckPack(JSON.parse(hub.artifacts[0]!.content));
}

test("edits made around a conflicting save land on the other writer's pack; typed text keeps its spacing", async () => {
  const { hub, autosave } = await open(recommendedPack(repo));
  writeElsewhere(hub, (pack) => ({ ...pack, checks: { ...pack.checks, "ci-green": { enabled: false } } }));

  autosave.edit((draft) => append(draft, "pass", { do: "comment", target: { body: "Thanks!  " } }));
  const saving = autosave.flush();
  autosave.edit((draft) => maxFiles(draft, 10));
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
  const { hub, autosave } = await open(null);

  autosave.edit((draft) => ({ ...draft, policy: { ...draft.policy, enabled: true } }));
  await autosave.flush();
  expect(hub.artifacts).toEqual([]);

  autosave.edit((draft) => ({ ...draft, pack: { ...draft.pack, checks: { ...draft.pack.checks, "ci-green": { enabled: true } } } }));
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

const PAIR: CheckPack = { ...recommendedPack(repo), actions: { ...recommendedPack(repo).actions, pass: [{ do: "approve" }, { do: "close" }] } };

function rule(id: string, claim: string, name = claim): CustomCheck {
  return { id, name, group: "pull-request", kind: "model", shape: "is-true", claim };
}

function comment(body: string): Step {
  return { do: "comment", target: { body } };
}

test("a saved step left unfinished survives another writer's save, and a third writer's removal is not undone", async () => {
  const first = await open(PAIR);
  const [, close] = stepEntries(first.session.saved, "pass");
  first.autosave.edit((draft) => editStep(draft, close!.id, comment("")));
  await first.autosave.flush();
  writeElsewhere(first.hub, (pack) => ({ ...pack, checks: { ...pack.checks, docs: { enabled: false } } }));
  first.autosave.edit((draft) => maxFiles(draft, 7));
  await first.autosave.flush();
  expect(stored(first.hub).actions.pass).toEqual([{ do: "approve" }, { do: "close" }]);

  let third = true;
  const second = await open({ ...PAIR, actions: { ...PAIR.actions, pass: [{ do: "approve" }, { do: "close" }, comment("x")] } }, function thirdWriter(hub) {
    if (!third) return;
    third = false;
    writeElsewhere(hub, (pack) => ({ ...pack, actions: { ...pack.actions, pass: [{ do: "approve" }] } }));
  });
  writeElsewhere(second.hub, (pack) => ({ ...pack, actions: { ...pack.actions, pass: [{ do: "approve" }, comment("x")] } }));
  second.autosave.edit((draft) => maxFiles(draft, 7));
  await second.autosave.flush();
  expect(second.autosave.state().error).not.toBe("");
  await second.autosave.flush();
  expect(stored(second.hub).checks["max-files-changed"]?.maxFiles).toBe(7);
  expect(stored(second.hub).actions.pass).toEqual([{ do: "approve" }]);
});

test("spacing the contract trims is not a change, so it never overwrites the other writer's rule, label or step", async () => {
  const { hub, session, autosave } = await open({ ...PAIR, custom: [rule("r", "the title is good")] });
  const [, close] = stepEntries(session.saved, "pass");
  autosave.edit((draft) => editStep({ ...draft, pack: { ...draft.pack, custom: [rule("r", "the title is good ", "the title is good")], labels: { ...draft.pack.labels, pass: "Ready " } } }, close!.id, comment("hi  ")));
  await autosave.flush();
  writeElsewhere(hub, (pack) => ({ ...pack, custom: [rule("r", "the title names the change")], labels: { ...pack.labels, pass: "Good to go" }, actions: { ...pack.actions, pass: [{ do: "approve" }, comment("hello")] } }));
  autosave.edit((draft) => maxFiles(draft, 7));
  await autosave.flush();
  expect(stored(hub).custom[0]!.claim).toBe("the title names the change");
  expect(stored(hub).labels.pass).toBe("Good to go");
  expect(stored(hub).actions.pass).toEqual([{ do: "approve" }, comment("hello")]);
  expect(autosave.state().conflicts).toEqual([]);
});

test("a built-in rule merges key by key, and a rule both sides changed keeps ours and says so", async () => {
  const { hub, autosave } = await open({ ...PAIR, custom: [rule("r", "the title is good")] });
  writeElsewhere(hub, (pack) => ({ ...pack, checks: { ...pack.checks, "max-files-changed": { ...pack.checks["max-files-changed"]!, enabled: false } }, custom: [rule("r", "theirs")] }));
  autosave.edit((draft) => maxFiles(draft, 7));
  autosave.edit((draft) => ({ ...draft, pack: { ...draft.pack, custom: [rule("r", "ours")] } }));
  await autosave.flush();
  expect(stored(hub).checks["max-files-changed"]).toEqual({ enabled: false, maxFiles: 7 });
  expect(stored(hub).custom.map((row) => row.claim)).toEqual(["ours"]);
  expect(autosave.state().conflicts).toEqual(["ours"]);
});

test("both sides adding the same step keep one copy, in the draft too", async () => {
  const { hub, autosave } = await open(PAIR);
  writeElsewhere(hub, (pack) => ({ ...pack, actions: { ...pack.actions, pass: [...pack.actions.pass, { do: "merge" }] } }));
  autosave.edit((draft) => append(draft, "pass", { do: "merge" }));
  await autosave.flush();
  expect(stored(hub).actions.pass).toEqual([{ do: "approve" }, { do: "close" }, { do: "merge" }]);
  expect(autosave.state().draft.pack.actions.pass).toEqual([{ do: "approve" }, { do: "close" }, { do: "merge" }]);
});

test("no two rule rows share a key after a merge renames ours", async () => {
  const { hub, autosave } = await open(PAIR);
  autosave.edit((draft) => ({ ...draft, pack: { ...draft.pack, custom: [rule("is-it-true", "", "Is it true")] } }));
  await autosave.flush();
  writeElsewhere(hub, (pack) => ({ ...pack, custom: [rule("is-it-true", "their claim", "Is it true")] }));
  autosave.edit((draft) => maxFiles(draft, 7));
  await autosave.flush();
  const merged = autosave.state().draft;
  expect(new Set(merged.pack.custom.map((row) => merged.ruleKeys?.[row.id] ?? row.id)).size).toBe(2);
});
