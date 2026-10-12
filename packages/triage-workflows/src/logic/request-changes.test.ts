import { describe, expect, test } from "bun:test";
import { getReviews, REQUEST_CHANGES_DO_MARKER, type GithubFetch } from "@corbits/github-tool/github";
import { ALL_CHECKS, DEFAULT_REPO_POLICY, emptyPack, type CheckPack } from "@corbits/triage-contracts";
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
  baseBehindBy: 0,
  checks: "success",
  requestedReviewers: 1,
  reviewers: ["alice"],
  reviewedBy: [],
  approvals: 0,
  openPrs: [],
  labels: [],
  assignees: [],
  paths: ["src/search.ts"],
  events: ["updated"],
};

const pack: CheckPack = {
  ...emptyPack("acme/widgets"),
  checks: { draft: { enabled: true }, conflicts: { enabled: true }, ci: { enabled: true } },
  actions: [{
    id: "gate",
    when: "every",
    checks: [ALL_CHECKS],
    branches: { yes: [{ kind: "approve", automatic: true, target: {} }], no: [{ kind: "request-changes", automatic: true, target: {} }] },
  }],
};

function input(over: Partial<PrFacts>, using = pack) {
  const pr = { ...facts, ...over };
  const det = deriveState(pr, undefined, using);
  const rendered = renderVerdict({ author: pr.author, repo: pr.repo, headSha: pr.headSha, det, answers: null, threshold: 0 });
  return { rendered, input: { facts: pr, checks: rendered.checks, pack: using, roles: {} } };
}

function suggested(over: Partial<PrFacts>, using = pack) {
  const { rendered, input: actionInput } = input(over, using);
  return heldApprovals(evaluateActions(actionInput), approvalHeldBy(rendered.merge.verdict, actionInput.facts.checks));
}

const APP = "corbits-triage[bot]";

/** Facts from GitHub reviews as the App reads them, so only its own marked review is triage's. */
async function reviewFacts(rows: unknown[]): Promise<Partial<PrFacts>> {
  const gh: GithubFetch = async () => Response.json(rows);
  const reviews = await getReviews(gh, "acme/widgets", 8, async function login() {
    return APP;
  });
  const { changesRequested, reviewAnswered, triageRequested } = buildFacts("acme/widgets", 8, { author: "octocat", branch: "a", sha: "def" }, [], reviews, [], [], DEFAULT_REPO_POLICY);
  return { changesRequested, reviewAnswered, triageRequested };
}

function markedRequest(login: string) {
  return { id: 1, user: { login, type: "Bot" }, state: "CHANGES_REQUESTED", commit_id: "abc", submitted_at: "2026-10-01T10:00:00Z", body: `${REQUEST_CHANGES_DO_MARKER}\nTriage requests changes:` };
}

const CI_ONLY: CheckPack = {
  ...emptyPack("acme/widgets"),
  checks: { ci: { enabled: true }, conflicts: { enabled: true } },
  actions: [{ id: "ci-gate", when: "every", checks: ["ci"], branches: { no: [{ kind: "request-changes", automatic: true, target: {} }] } }],
};

describe("the request-changes Do", () => {
  test("triage's own request on an earlier head is not a reviewer's, so the fixed head approves", async () => {
    expect(suggested(await reviewFacts([markedRequest(APP)]))).toEqual([expect.objectContaining({ kind: "approve", branch: "yes" })]);
  });

  test("another bot's request carrying the marker is still a reviewer's", async () => {
    expect((await reviewFacts([markedRequest("other-review-bot[bot]")])).changesRequested).toEqual(["other-review-bot[bot]"]);
  });

  test("a pack that no longer requests changes takes back the App's standing request, and has nothing to decide without one", async () => {
    const plain = { ...pack, actions: [] };
    expect(changesWanted(input(await reviewFacts([markedRequest(APP)]), plain).input)).toBe(false);
    expect(changesWanted(input({}, plain).input)).toBeUndefined();
  });

  test("an action on CI lists only CI, and stops wanting changes once CI is fixed though conflicts remain", () => {
    const [step] = suggested({ checks: "failure", failingChecks: ["build"], mergeable: false }, CI_ONLY);
    expect(step).toMatchObject({ kind: "request-changes", target: { body: expect.not.stringMatching(/onflict/) } });
    expect(changesWanted(input({ mergeable: false }, CI_ONLY).input)).toBe(false);
  });

  test("lists only the failed checks that are the author's to fix", () => {
    expect(suggested({ checks: "failure", failingChecks: ["build"] })).toEqual([
      expect.objectContaining({ kind: "request-changes", branch: "no", target: { body: expect.stringMatching(/^Triage requests changes:\n- .+: /) } }),
    ]);
  });

  test("is skipped when nothing failed is the author's to fix", () => {
    expect(suggested({ draft: true })).toEqual([expect.objectContaining({ kind: "request-changes", skipped: true })]);
  });
});
