import { describe, expect, test } from "bun:test";
import { checkFailed, checkPending, isTriageComment, latestDecisive, reviewedOnHead, summarizeChecks } from "@corbits/github-reads";
import { POLICY_FILE_MAX_BYTES } from "@corbits/triage-contracts";
import { defaultReviewers, getChecks, getPr, getReviews, listIssueComments, listOpenPrs, listPrCommits, listPrFiles, readRepoFile, type BitbucketFetch } from "./index.js";
import activities from "./fixtures/activities.json";
import branchDefault from "./fixtures/branch-default.json";
import browseType from "./fixtures/browse-type.json";
import buildStatus from "./fixtures/build-status.json";
import changes from "./fixtures/changes.json";
import commits from "./fixtures/commits.json";
import diffStats from "./fixtures/diff-stats-summary.json";
import fileCommits from "./fixtures/file-commits.json";
import merge from "./fixtures/merge.json";
import pullRequest from "./fixtures/pull-request.json";
import pullRequestsOpen from "./fixtures/pull-requests-open.json";
import repository from "./fixtures/repository.json";
import usersProjectAdmin from "./fixtures/users-project-admin.json";

const REPO = "/rest/api/1.0/projects/TRI/repos/widgets";
const HEAD = pullRequest.fromRef.latestCommit;

type Routes = Array<[prefix: string, reply: unknown]>;

/** Answers each request with the reply of the first route its path starts with; Bitbucket answers 404 for anything else. */
function instance(routes: Routes) {
  const paths: string[] = [];
  async function bb(path: string): Promise<Response> {
    paths.push(path);
    const route = routes.find(([prefix]) => path.startsWith(prefix));
    if (route === undefined) return Response.json({ errors: [] }, { status: 404 });
    return route[1] instanceof Response ? route[1] : Response.json(route[1]);
  }
  return { bb: bb satisfies BitbucketFetch, paths };
}

const empty = { values: [], isLastPage: true, start: 0, size: 0, limit: 100 };

const recorded: Routes = [
  [`${REPO}/pull-requests/1/merge`, merge],
  [`${REPO}/pull-requests/1/diff-stats-summary`, diffStats],
  [`${REPO}/pull-requests/1/changes`, changes],
  [`${REPO}/pull-requests/1/commits`, commits],
  [`${REPO}/pull-requests/1/activities`, activities],
  [`${REPO}/pull-requests/1`, pullRequest],
  [`/rest/build-status/1.0/commits/${HEAD}`, buildStatus],
  ["/rest/api/1.0/users?filter=admin&permission=PROJECT_ADMIN&", usersProjectAdmin],
  ["/rest/api/1.0/users?", empty],
];

describe("getPr", () => {
  test("reads the recorded pull request in the GitHub shape, with the author's association from their effective permission", async () => {
    const { bb } = instance(recorded);
    expect(await getPr(bb, "TRI/widgets", 1)).toMatchObject({
      number: 1,
      title: "Add subtract",
      body: pullRequest.description,
      state: "open",
      merged: false,
      draft: false,
      author: "admin",
      authorAssociation: "OWNER",
      authorBot: false,
      sha: HEAD,
      branch: "feature/subtract",
      base: "main",
      mergeable: true,
      canMerge: true,
      mergeVetoes: [],
      reviewers: [],
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  });

  test("an author with no project or repository permission is NONE", async () => {
    const { bb } = instance(recorded.filter(([prefix]) => !prefix.includes("PROJECT_ADMIN")));
    expect((await getPr(bb, "TRI/widgets", 1)).authorAssociation).toBe("NONE");
  });
});

describe("listOpenPrs", () => {
  test("follows nextPageStart until the last page", async () => {
    const [row] = pullRequestsOpen.values;
    const { bb, paths } = instance([
      [`${REPO}/pull-requests?state=OPEN&limit=100&start=0`, { ...pullRequestsOpen, isLastPage: false, nextPageStart: 100 }],
      [`${REPO}/pull-requests?state=OPEN&limit=100&start=100`, { ...pullRequestsOpen, values: [{ ...row, id: 2 }] }],
    ]);
    expect((await listOpenPrs(bb, "TRI/widgets")).map((pr) => pr.number)).toEqual([1, 2]);
    expect(paths).toHaveLength(2);
  });
});

describe("getChecks", () => {
  test("build statuses on the head become check runs: failed, in progress and successful", async () => {
    const { bb } = instance(recorded);
    const runs = await getChecks(bb, HEAD);
    expect(summarizeChecks(runs)).toBe("failure");
    expect(runs.filter(checkFailed).map((run) => run.name)).toEqual(["test"]);
    expect(runs.filter(checkPending).map((run) => run.name)).toEqual(["e2e"]);
    expect(summarizeChecks(await getChecks(instance([[`/rest/build-status/1.0/commits/${HEAD}`, empty]]).bb, HEAD))).toBe("none");
  });
});

describe("getReviews", () => {
  // Built from the recorded author participant; this instance has a single user, who cannot review their own pull request.
  function reviewer(slug: string, status: string, lastReviewedCommit: string) {
    return { ...pullRequest.author, user: { ...pullRequest.author.user, slug }, role: "REVIEWER", status, lastReviewedCommit };
  }
  const reviewed = {
    ...pullRequest,
    reviewers: [reviewer("ada", "APPROVED", HEAD), reviewer("grace", "NEEDS_WORK", "66af7477a3b53db35d1556d16823b6e07970b09a"), reviewer("linus", "UNAPPROVED", HEAD)],
  };

  test("approval and needs work map to GitHub review states, standing on head only for the commit last reviewed", async () => {
    const { bb } = instance([[`${REPO}/pull-requests/1/activities`, activities], [`${REPO}/pull-requests/1`, reviewed]]);
    const reviews = await getReviews(bb, "TRI/widgets", 1, "grace");
    expect([...latestDecisive(reviews)]).toEqual([["ada", "APPROVED"]]);
    expect(reviews.find((review) => review.reviewer === "grace")).toMatchObject({ state: "CHANGES_REQUESTED", triageRequest: true });
    expect(reviewedOnHead(reviews, HEAD)).toEqual(["ada"]);
  });
});

describe("listIssueComments", () => {
  test("comments come oldest first with replies, and the triage marker comment is recognised", async () => {
    const { bb } = instance(recorded);
    const comments = await listIssueComments(bb, "TRI/widgets", 1);
    expect(comments.map((comment) => comment.id)).toEqual([2, 3, 4, 6]);
    expect(comments.filter((comment) => isTriageComment(comment.body)).map((comment) => comment.id)).toEqual([3]);
    expect(comments[0]).toMatchObject({ author: "admin", bot: false, createdAt: "2026-10-14T17:41:13.731Z" });
  });
});

describe("listPrFiles and listPrCommits", () => {
  test("changes carry the GitHub file status and commits their git author when no user matches", async () => {
    const { bb } = instance(recorded);
    expect(await listPrFiles(bb, "TRI/widgets", 1)).toEqual([{ path: "src/subtract.ts", status: "added" }]);
    expect(await listPrCommits(bb, "TRI/widgets", 1)).toEqual([{ sha: HEAD, message: "add subtract", author: "dev", committedAt: "2026-10-14T17:28:30.000Z" }]);
  });
});

describe("defaultReviewers", () => {
  test("asks for the pull request's refs and repositories and leaves out its author", async () => {
    const users = [pullRequest.author.user, { ...pullRequest.author.user, slug: "ada" }];
    const { bb, paths } = instance([["/rest/default-reviewers/1.0/", users], [`${REPO}/pull-requests/1`, pullRequest]]);
    expect(await defaultReviewers(bb, "TRI/widgets", 1)).toEqual({ users: ["ada"], teams: [] });
    expect(paths[1]).toBe("/rest/default-reviewers/1.0/projects/TRI/repos/widgets/reviewers?sourceRepoId=2&targetRepoId=2&sourceRefId=refs%2Fheads%2Ffeature%2Fsubtract&targetRefId=refs%2Fheads%2Fmain");
  });
});

describe("readRepoFile", () => {
  const at = `at=${branchDefault.latestCommit}`;
  function file(raw: Response): Routes {
    return [
      [`${REPO}/branches/default`, branchDefault],
      [`${REPO}/browse/.corbits-triage.yaml?type=true&${at}`, browseType],
      [`${REPO}/raw/.corbits-triage.yaml?${at}`, raw],
      [`${REPO}/commits?path=.corbits-triage.yaml&until=${branchDefault.latestCommit}`, fileCommits],
      [REPO, repository],
    ];
  }

  test("reads the file at the default branch head with the commit that last changed it", async () => {
    const { bb } = instance(file(new Response("checks: {}\n")));
    expect(await readRepoFile(bb, "TRI/widgets", ".corbits-triage.yaml")).toEqual({
      kind: "file",
      sha: fileCommits.values[0]!.id,
      text: "checks: {}\n",
      url: "https://bitbucket.example/projects/TRI/repos/widgets/browse/.corbits-triage.yaml",
    });
  });

  test("a file past the cap has no text, and a missing file is undefined", async () => {
    const big = await readRepoFile(instance(file(new Response("x".repeat(POLICY_FILE_MAX_BYTES + 1)))).bb, "TRI/widgets", ".corbits-triage.yaml");
    expect(big).toMatchObject({ kind: "file", text: null });
    expect(await readRepoFile(instance([[`${REPO}/branches/default`, branchDefault]]).bb, "TRI/widgets", ".corbits-triage.yaml")).toBeUndefined();
  });
});
