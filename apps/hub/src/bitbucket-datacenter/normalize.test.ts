import { describe, expect, test } from "bun:test";
import { triageEventOf } from "@corbits/triage-contracts";
import { normalizeBitbucket } from "./normalize.js";

const repository = { slug: "widgets", id: 2, name: "widgets", project: { key: "TRI", id: 2, name: "Triage Dev" } };

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    version: 1,
    title: "Add subtract",
    description: "Adds subtract next to add.",
    state: "OPEN",
    open: true,
    closed: false,
    draft: false,
    fromRef: { id: "refs/heads/feature/subtract", displayId: "feature/subtract", latestCommit: "3e1552b0", type: "BRANCH", repository },
    toRef: { id: "refs/heads/main", displayId: "main", latestCommit: "66af7477", type: "BRANCH", repository },
    author: { user: { name: "admin", slug: "admin", displayName: "admin" }, role: "AUTHOR", approved: false, status: "UNAPPROVED" },
    reviewers: [{ user: { name: "rev", slug: "rev" }, role: "REVIEWER", approved: true, status: "APPROVED" }],
    participants: [],
    ...overrides,
  };
}

function prEvent(eventKey: string, extra: Record<string, unknown> = {}) {
  return { eventKey, date: "2026-10-14T17:41:14+0000", actor: { name: "rev", slug: "rev" }, pullRequest: pullRequest(), ...extra };
}

function mailOf(eventKey: string, payload: Record<string, unknown>) {
  const intake = normalizeBitbucket(eventKey, "8c8f041c", payload);
  if (intake?.kind !== "pr") throw new Error(`${eventKey} gave ${JSON.stringify(intake)}`);
  return intake.mail;
}

describe("normalizeBitbucket", () => {
  test("pull request events carry the PROJECTKEY/slug repository, head and author under GitHub's names", () => {
    expect(mailOf("pr:opened", prEvent("pr:opened"))).toEqual({
      kind: "pr",
      repo: "TRI/widgets",
      prNumber: 1,
      deliveryId: "8c8f041c",
      event: "pull_request",
      action: "opened",
      headSha: "3e1552b0",
      author: "admin",
      title: "Add subtract",
      body: "Adds subtract next to add.",
      draft: false,
      review: null,
    });
  });

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
  ] as const)("%s %j wakes triage as %s", (eventKey, extra, expected) => {
    expect(triageEventOf(mailOf(eventKey, prEvent(eventKey, extra)))).toBe(expected);
  });

  test("triage's own comment and closed pull requests are ignored", () => {
    expect(normalizeBitbucket("pr:comment:added", "d", prEvent("pr:comment:added", { comment: { text: "<!-- corbits-triage -->\nTriage: looks fine." } }))).toBeNull();
    expect(normalizeBitbucket("pr:declined", "d", prEvent("pr:declined", { pullRequest: pullRequest({ state: "DECLINED" }) }))).toBeNull();
    expect(normalizeBitbucket("pr:deleted", "d", prEvent("pr:deleted"))).toBeNull();
    expect(normalizeBitbucket("pr:comment:added", "d", prEvent("pr:comment:added", { pullRequest: pullRequest({ state: "MERGED" }), comment: { text: "late" } }))).toBeNull();
  });

  test("a merge moves the base for the repository's other pull requests", () => {
    expect(normalizeBitbucket("pr:merged", "d", prEvent("pr:merged", { pullRequest: pullRequest({ state: "MERGED" }) }))).toEqual({
      kind: "base-move",
      move: { repo: "TRI/widgets", merged: 1 },
    });
  });

  test("a branch update may have changed the policy file; a deleted branch or a tag cannot", () => {
    function refsChanged(type: string, refType: string) {
      return { eventKey: "repo:refs_changed", actor: { slug: "admin" }, repository, changes: [{ ref: { id: "refs/heads/main", displayId: "main", type: refType }, refId: "refs/heads/main", fromHash: "66af7477", toHash: "9b1c2d3e", type }] };
    }
    expect(normalizeBitbucket("repo:refs_changed", "d", refsChanged("UPDATE", "BRANCH"))).toEqual({ kind: "policy-push", push: { repo: "TRI/widgets", removed: false } });
    expect(normalizeBitbucket("repo:refs_changed", "d", refsChanged("DELETE", "BRANCH"))).toBeNull();
    expect(normalizeBitbucket("repo:refs_changed", "d", refsChanged("ADD", "TAG"))).toBeNull();
  });
});
