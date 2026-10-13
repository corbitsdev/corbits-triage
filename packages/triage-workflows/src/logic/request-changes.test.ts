import { describe, expect, test } from "bun:test";
import { getReviews, REQUEST_CHANGES_DO_MARKER, type GithubFetch } from "@corbits/github-reads";
import { DEFAULT_REPO_POLICY, defaultActions, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { approvalHeldBy, changesWanted, evaluateActions, heldApprovals } from "./actions.js";
import { deriveState, type PrFacts } from "./checks.js";
import { buildFacts } from "./facts.js";
import { renderVerdict } from "./render.js";

const facts: PrFacts = {
  repo: "acme/widgets",
  number: 8,
  title: "feat: search",
  author: "octocat",
  tier: "external",
  headSha: "def",
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
  events: ["updated"],
};

const pack: CheckPack = {
  ...emptyPack("acme/widgets"),
  checks: { "no-merge-conflicts": { enabled: true }, "ci-green": { enabled: true } },
  actions: { ...defaultActions(), pass: [{ do: "approve" }], fail: [{ do: "request-changes" }] },
};

/** The verdict as the evaluate step renders it, the verdict question answering pass when no hard rule failed. */
function input(over: Partial<PrFacts>, using = pack) {
  const pr = { ...facts, ...over };
  const det = deriveState(pr, undefined, using);
  const rendered = renderVerdict({ author: pr.author, repo: pr.repo, headSha: pr.headSha, det, answers: null, choice: { pass: 0.9, fail: 0.05, cant_tell: 0.05 } });
  return { rendered, input: { facts: pr, checks: rendered.checks, verdict: rendered.verdict, reason: rendered.reason, pack: using, roles: {} } };
}

function suggested(over: Partial<PrFacts>, using = pack) {
  const { rendered, input: actionInput } = input(over, using);
  return heldApprovals(evaluateActions(actionInput), approvalHeldBy(rendered.verdict, actionInput.facts.checks));
}

const APP = "corbits-triage[bot]";

/** Facts from GitHub reviews as the App reads them, so only its own marked review is triage's. */
async function reviewFacts(rows: unknown[]): Promise<Partial<PrFacts>> {
  const gh: GithubFetch = async () => Response.json(rows);
  const reviews = await getReviews(gh, "acme/widgets", 8, async function login() {
    return APP;
  });
  const { changesRequested, reviewAnswered, triageRequested } = buildFacts("acme/widgets", 8, { author: "octocat", branch: "a", sha: "def" }, [], reviews, [], DEFAULT_REPO_POLICY);
  return { changesRequested, reviewAnswered, triageRequested };
}

function markedRequest(login: string) {
  return { id: 1, user: { login, type: "Bot" }, state: "CHANGES_REQUESTED", commit_id: "abc", submitted_at: "2026-10-01T10:00:00Z", body: `${REQUEST_CHANGES_DO_MARKER}\nTriage requests changes:` };
}

describe("the request-changes Do", () => {
  test("triage's own request on an earlier head is not a reviewer's, so the fixed head approves", async () => {
    expect(suggested(await reviewFacts([markedRequest(APP)]))).toEqual([expect.objectContaining({ kind: "approve", list: "pass" })]);
  });

  test("another bot's request carrying the marker is still a reviewer's", async () => {
    expect((await reviewFacts([markedRequest("other-review-bot[bot]")])).changesRequested).toEqual(["other-review-bot[bot]"]);
  });

  test("a pack that no longer requests changes takes back the App's standing request, and has nothing to decide without one", async () => {
    const plain = { ...pack, actions: defaultActions() };
    expect(changesWanted(input(await reviewFacts([markedRequest(APP)]), plain).input)).toBe(false);
    expect(changesWanted(input({}, plain).input)).toBeUndefined();
  });

  test("lists every failed rule that is the author's to fix, and stops wanting changes once they are fixed", () => {
    expect(suggested({ checks: "failure", failingChecks: ["build"], mergeable: false })).toEqual([
      expect.objectContaining({ kind: "request-changes", list: "fail", target: { body: "Triage requests changes:\n- CI green: required checks are failing\n- No merge conflicts: merge conflicts with base" } }),
    ]);
    expect(changesWanted(input({}).input)).toBe(false);
  });

  test("is skipped when nothing failed is the author's to fix", () => {
    expect(suggested({ changesRequested: ["maya"] })).toEqual([expect.objectContaining({ kind: "request-changes", skipped: true })]);
  });
});
