import { describe, expect, test } from "bun:test";
import { ALL_CHECKS, emptyPack, type CheckPack, type CustomCheck } from "@corbits/triage-contracts";
import { approvalHeldBy, evaluateActions, heldApprovals } from "./actions.js";
import { deriveState, type PrFacts } from "./checks.js";
import { renderVerdict } from "./render.js";

const facts: PrFacts = {
  repo: "acme/widgets",
  number: 8,
  title: "feat: search",
  author: "octocat",
  tier: "external",
  headSha: "abc",
  state: "open",
  draft: false,
  mergeable: true,
  checks: "success",
  reviewers: ["alice"],
  reviewedBy: [],
  approvals: 0,
  labels: [],
  assignees: [],
  paths: ["src/search.ts"],
  events: ["opened"],
};

const VENDOR: CustomCheck = { id: "custom-1", name: "Vendor", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["vendor/**"] };

const pack: CheckPack = {
  ...emptyPack("acme/widgets"),
  checks: { conflicts: { enabled: true }, ci: { enabled: true } },
  actions: [{ id: "approve", when: ["opened"], checks: [ALL_CHECKS], branches: { yes: [{ kind: "approve", automatic: true, target: {} }] } }],
};

/** The actions a run suggests for `over` on `facts`, as the evaluate step derives, renders and holds them. */
function suggested(using: CheckPack, over: Partial<PrFacts> = {}) {
  const pr = { ...facts, ...over };
  const det = deriveState(pr, undefined, using);
  const rendered = renderVerdict({ author: pr.author, repo: pr.repo, headSha: pr.headSha, det, answers: null, threshold: 0 });
  return heldApprovals(evaluateActions({ facts: pr, checks: rendered.checks, pack: using, roles: {} }), approvalHeldBy(rendered.merge.verdict, pr.checks));
}

describe("approving on every check", () => {
  test("approves once every check the pack runs passes and CI is green", () => {
    expect(suggested(pack)).toEqual([expect.objectContaining({ kind: "approve", branch: "yes", automatic: true })]);
  });

  test("a failing check approves nothing", () => {
    expect(suggested(pack, { draft: true })).toEqual([]);
  });

  test.each<[string, PrFacts["checks"]]>([
    ["pending", "pending"],
    ["not reported yet", "none"],
  ])("CI %s holds the approval, even with the CI check turned off", (_, checks) => {
    const held = [expect.objectContaining({ kind: "approve", skipped: true, reason: "CI has not passed on this head." })];
    expect(suggested(pack, { checks })).toEqual(held);
    expect(suggested({ ...pack, checks: { ...pack.checks, ci: { enabled: false } } }, { checks })).toEqual(held);
  });

  test("a check turned off no longer decides, and a custom check added later must pass", () => {
    expect(suggested({ ...pack, checks: { ...pack.checks, conflicts: { enabled: false } } }, { mergeable: false })).toEqual([expect.objectContaining({ kind: "approve", branch: "yes" })]);
    const custom = { ...pack, custom: [VENDOR] };
    expect(suggested(custom)).toEqual([expect.objectContaining({ kind: "approve" })]);
    expect(suggested(custom, { paths: ["vendor/lib.ts"] })).toEqual([]);
  });
});
