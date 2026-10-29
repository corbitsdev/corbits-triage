import { describe, expect, test } from "bun:test";
import { triageEventOf } from "@corbits/triage-contracts";
import { normalizeBitbucket } from "./normalize.js";

const repository = { slug: "widgets", project: { key: "TRI" } };

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Add subtract",
    state: "OPEN",
    draft: false,
    fromRef: { latestCommit: "3e1552b0", repository },
    toRef: { displayId: "main", repository },
    author: { user: { slug: "admin" } },
    ...overrides,
  };
}

function prEvent(eventKey: string, extra: Record<string, unknown> = {}) {
  return { eventKey, actor: { slug: "rev" }, pullRequest: pullRequest(), ...extra };
}

describe("normalizeBitbucket", () => {
  test.each([
    ["pr:opened", {}, "opened"],
    ["pr:modified", { previousTitle: "Old", previousDraft: false }, "updated"],
    ["pr:modified", { previousDraft: true }, "ready"],
    ["pr:modified", { previousDraft: false, pullRequest: pullRequest({ draft: true }) }, "drafted"],
    ["pr:from_ref_updated", { previousFromHash: "aaaa" }, "updated"],
    ["pr:reviewer:approved", { participant: { status: "APPROVED" } }, "approved"],
    ["pr:reviewer:needs_work", { participant: { status: "NEEDS_WORK" } }, "changes-requested"],
    ["pr:reviewer:unapproved", { participant: { status: "UNAPPROVED" } }, null],
    ["pr:comment:added", { comment: { id: 4, text: "Please also add multiply.", author: { slug: "rev" } } }, "commented"],
    ["pr:comment:edited", { comment: { id: 4, text: "Rename it.", threadResolved: true }, previousComment: "Rename it." }, "threads"],
    ["pr:comment:edited", { comment: { id: 4, text: "Rename it.", threadResolved: false }, previousComment: "Rename it." }, "threads"],
    ["pr:declined", { pullRequest: pullRequest({ state: "DECLINED" }) }, "closed"],
    ["pr:deleted", {}, "closed"],
  ] as const)("%s %j wakes triage as %s", (eventKey, extra, expected) => {
    const intake = normalizeBitbucket(eventKey, "d", prEvent(eventKey, extra));
    if (intake?.kind !== "pr") throw new Error(`${eventKey} gave ${JSON.stringify(intake)}`);
    expect(triageEventOf(intake.mail)).toBe(expected);
  });

  test("an edit of a comment's text wakes nothing", () => {
    expect(normalizeBitbucket("pr:comment:edited", "d", prEvent("pr:comment:edited", { comment: { id: 4, text: "Rename it, please." }, previousComment: "Rename it." }))).toBeNull();
  });

  test("triage's own comments and comments on a pull request no longer open are ignored", () => {
    expect(normalizeBitbucket("pr:comment:added", "d", prEvent("pr:comment:added", { comment: { text: "[corbits-triage]: #%7B%7D\nTriage: looks fine." } }))).toBeNull();
    expect(normalizeBitbucket("pr:comment:added", "d", prEvent("pr:comment:added", { comment: { text: "[corbits-action]: #e1\nHello" } }))).toBeNull();
    expect(normalizeBitbucket("pr:comment:added", "d", prEvent("pr:comment:added", { pullRequest: pullRequest({ state: "MERGED" }), comment: { text: "late" } }))).toBeNull();
  });
});
