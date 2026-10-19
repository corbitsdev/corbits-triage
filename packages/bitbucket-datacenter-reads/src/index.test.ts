import { describe, expect, test } from "bun:test";
import { checkFailed, checkPending, latestDecisive, reviewedOnHead } from "@corbits/github-reads";
import { getChecks, getPr, getReviews, isTriageComment, listIssueComments, listPrTimeline, readRepoFile, readStack, type BitbucketFetch } from "./index.js";
import activities from "./fixtures/activities.json";
import buildStatus from "./fixtures/build-status.json";
import pullRequest from "./fixtures/pull-request.json";

const REPO = "/rest/api/1.0/projects/TRI/repos/widgets";
const HEAD = pullRequest.fromRef.latestCommit;

type Routes = Array<[prefix: string, reply: unknown]>;

/** Answers each request with the reply of the first route its path starts with; Bitbucket answers 404 for anything else. */
function instance(routes: Routes): BitbucketFetch {
  return async function bb(path) {
    const route = routes.find(([prefix]) => path.startsWith(prefix));
    if (route === undefined) return Response.json({ errors: [] }, { status: 404 });
    return route[1] instanceof Response ? route[1] : Response.json(route[1]);
  };
}

function page(values: unknown[]) {
  return { values, isLastPage: true };
}

describe("getPr", () => {
  test("mergeable means free of conflicts, apart from the merge checks, and the author's project admin makes them OWNER", async () => {
    const vetoed = { canMerge: false, conflicted: false, outcome: "CLEAN", vetoes: [{ summaryMessage: "Needs 2 approvals" }] };
    const routes: Routes = [
      [`${REPO}/pull-requests/1/diff-stats-summary`, { filesChanged: 1, totalInsertions: 1, totalDeletions: 0 }],
      [`${REPO}/pull-requests/1`, pullRequest],
      ["/rest/api/1.0/users?filter=admin&permission=PROJECT_ADMIN&", page([{ slug: "admin" }])],
      ["/rest/api/1.0/users?", page([])],
    ];
    expect(await getPr(instance([[`${REPO}/pull-requests/1/merge`, vetoed], ...routes]), "TRI/widgets", 1)).toMatchObject({
      authorAssociation: "OWNER",
      sha: HEAD,
      mergeable: true,
      canMerge: false,
      mergeVetoes: ["Needs 2 approvals"],
    });
    const conflicted = { canMerge: false, conflicted: true, outcome: "CONFLICTED", vetoes: [] };
    expect((await getPr(instance([[`${REPO}/pull-requests/1/merge`, conflicted], ...routes]), "TRI/widgets", 1)).mergeable).toBe(false);
  });
});

test("getChecks: build statuses on the head become check runs, leaving out triage's own", async () => {
  const builds = page([...buildStatus.values, { state: "FAILED", key: "corbits-triage" }]);
  const runs = await getChecks(instance([[`/rest/build-status/1.0/commits/${HEAD}`, builds]]), HEAD);
  expect(runs.filter(checkFailed).map((run) => run.name)).toEqual(["test"]);
  expect(runs.filter(checkPending).map((run) => run.name)).toEqual(["e2e"]);
  expect(runs).toHaveLength(3);
});

describe("getReviews", () => {
  function reviewer(status: string, slug = "reviewer") {
    return { user: { slug }, role: "REVIEWER", status, lastReviewedCommit: HEAD };
  }

  async function reviews(pr: unknown, triageSlug?: string) {
    return getReviews(instance([[`${REPO}/pull-requests/1/activities`, activities], [`${REPO}/pull-requests/1`, pr]]), "TRI/widgets", 1, triageSlug);
  }

  test("approved and needs work become GitHub reviews on the commit last reviewed, timed by the last review activity; unapproved is none", async () => {
    const approved = await reviews(pullRequest);
    expect(approved).toEqual([{ reviewer: "reviewer", state: "APPROVED", submittedAt: "2026-10-14T17:52:27.884Z", commitId: HEAD }]);
    expect(reviewedOnHead(approved, HEAD)).toEqual(["reviewer"]);
    expect((await reviews({ ...pullRequest, reviewers: [reviewer("NEEDS_WORK")] }))[0]?.state).toBe("CHANGES_REQUESTED");
    expect(await reviews({ ...pullRequest, reviewers: [reviewer("UNAPPROVED")] })).toEqual([]);
  });

  test("needs work from the triage user, listed under participants, is triage's own request, not a reviewer's", async () => {
    const result = await reviews({ ...pullRequest, reviewers: [], participants: [reviewer("NEEDS_WORK", "triage-bot")] }, "triage-bot");
    expect(result).toEqual([{ reviewer: "triage-bot", state: "CHANGES_REQUESTED", commitId: HEAD, triageRequest: true }]);
    expect(latestDecisive(result).size).toBe(0);
  });
});

test("listIssueComments: oldest first with replies, and only the link reference marker, not an HTML comment, marks triage", async () => {
  const comments = await listIssueComments(instance([[`${REPO}/pull-requests/1/activities`, activities]]), "TRI/widgets", 1);
  expect(comments.map((comment) => comment.id)).toEqual([2, 3, 4, 6, 8, 10]);
  expect(comments.filter((comment) => isTriageComment(comment.body)).map((comment) => comment.id)).toEqual([8, 10]);
});

test("listPrTimeline: comments and review statuses oldest first in GitHub's terms, other activity left out", async () => {
  const events = await listPrTimeline(instance([[`${REPO}/pull-requests/1/activities`, activities]]), "TRI/widgets", 1);
  expect(events.map((event) => [event.kind, event.actor, event.state])).toEqual([
    ...Array.from({ length: 5 }, () => ["commented", "admin", undefined]),
    ["reviewed", "reviewer", "CHANGES_REQUESTED"],
    ["reviewed", "reviewer", "APPROVED"],
  ]);
  expect(events[0]).toEqual({ kind: "commented", actor: "admin", bot: false, at: "2026-10-14T17:41:13.750Z" });
});

test("readRepoFile: the file at the default branch head, its sha the commit that last changed it; a missing file is undefined", async () => {
  const head = "9b1c2d3e";
  const at = `at=${head}`;
  const routes: Routes = [
    [`${REPO}/branches/default`, { latestCommit: head }],
    [`${REPO}/browse/.corbits-triage.yaml?type=true&${at}`, { type: "FILE" }],
    [`${REPO}/raw/.corbits-triage.yaml?${at}`, new Response("checks: {}\n")],
    [`${REPO}/commits?path=.corbits-triage.yaml&until=${head}`, { values: [{ id: "5f0e1a2b" }] }],
    [REPO, { links: { self: [{ href: "https://bitbucket.example/projects/TRI/repos/widgets/browse" }] } }],
  ];
  expect(await readRepoFile(instance(routes), "TRI/widgets", ".corbits-triage.yaml")).toEqual({
    kind: "file",
    sha: "5f0e1a2b",
    text: "checks: {}\n",
    url: "https://bitbucket.example/projects/TRI/repos/widgets/browse/.corbits-triage.yaml",
  });
  expect(await readRepoFile(instance(routes.slice(0, 1)), "TRI/widgets", ".corbits-triage.yaml")).toBeUndefined();
});

describe("readStack", () => {
  const fix = { ...pullRequest.fromRef, id: "refs/heads/fix", displayId: "fix" };
  const parent = { ...pullRequest.toRef, id: "refs/heads/parent", displayId: "parent" };
  const stacked = { ...pullRequest, fromRef: fix, toRef: parent };

  test("names the pull requests merged into the branch and the open one whose branch it is based on", async () => {
    const merged = [{ ...pullRequest, id: 9, toRef: fix }, { ...pullRequest, id: 10, toRef: parent }];
    const routes: Routes = [
      [`${REPO}/pull-requests?state=MERGED&direction=INCOMING&at=refs%2Fheads%2Ffix&`, page(merged)],
      [`${REPO}/pull-requests?state=OPEN&direction=OUTGOING&at=refs%2Fheads%2Fparent&`, page([{ ...pullRequest, id: 7, fromRef: parent }])],
      [`${REPO}/pull-requests/1`, stacked],
    ];
    expect(await readStack(instance(routes), "TRI/widgets", 1)).toEqual({ includes: [9], onto: 7 });
  });

  test("a fork's branch is not stacked on this repository's", async () => {
    const fork = { ...stacked, fromRef: { ...fix, repository: { id: 3 } } };
    expect(await readStack(instance([[`${REPO}/pull-requests/1`, fork]]), "TRI/widgets", 1)).toEqual({ includes: [] });
  });
});
