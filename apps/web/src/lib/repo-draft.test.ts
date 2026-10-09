import { describe, expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { draftFromCheckPack, withChecksEnabled, withCheckValue } from "./check-catalog.ts";
import { unsavedChanges, type RepoDraft } from "./repo-draft.ts";

const saved: RepoDraft = { pack: draftFromCheckPack(recommendedPack("acme/widgets")), enabled: true, triageDrafts: true };

describe("unsaved changes", () => {
  test("the files and lines limits are one change, as the pack stores them", () => {
    const pack = withCheckValue(withCheckValue(saved.pack, saved.pack, "files", "maxFiles", 30), saved.pack, "size", "maxLines", 800);
    expect(unsavedChanges(saved, { ...saved, pack })).toBe(1);
  });

  test("switching a new check on and off again leaves nothing to save", () => {
    const empty: RepoDraft = { ...saved, pack: { ...saved.pack, checks: [] } };
    const on = withChecksEnabled(empty.pack, empty.pack, ["duplicate"], true);
    expect(unsavedChanges(empty, { ...empty, pack: on })).toBe(1);
    expect(unsavedChanges(empty, { ...empty, pack: withChecksEnabled(on, empty.pack, ["duplicate"], false) })).toBe(0);
  });

  test("a value changed and changed back leaves nothing to save", () => {
    const empty: RepoDraft = { ...saved, pack: { ...saved.pack, checks: [] } };
    const changed = withCheckValue(empty.pack, empty.pack, "drift", "maxCommits", 51);
    expect(unsavedChanges(empty, { ...empty, pack: changed })).toBe(1);
    expect(unsavedChanges(empty, { ...empty, pack: withCheckValue(changed, empty.pack, "drift", "maxCommits", 50) })).toBe(0);
    const tracker = withCheckValue(saved.pack, saved.pack, "issue", "tracker", "github");
    expect(unsavedChanges(saved, { ...saved, pack: withCheckValue(tracker, saved.pack, "issue", "tracker", "either") })).toBe(0);
  });

  test("posting mode and triage switches count alongside checks", () => {
    const pack = withChecksEnabled({ ...saved.pack, mode: "automated" }, saved.pack, ["ci"], false);
    expect(unsavedChanges(saved, { pack, enabled: false, triageDrafts: false })).toBe(4);
  });
});
