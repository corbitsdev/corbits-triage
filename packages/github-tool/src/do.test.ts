import { describe, expect, test } from "bun:test";
import { appLogin, REQUEST_CHANGES_DO_MARKER, type GithubFetch } from "@corbits/github-reads";
import { APPROVE_DO_MARKER } from "./github";
import { DoNotRunnableError, doMarker, executeDo, HeadMovedError, type DoStep, type ResolvedTarget } from "./do";

type FakeComment = { id: number; user: { login: string; type: string }; body: string };
type FakeReview = { id: number; user: { login: string; type: string }; state: string; commit_id: string; body?: string };

const APP = { login: "corbits-triage[bot]", type: "Bot" };

/** GitHub holding pull request 8, reviewed by `reviews` and with `approvals` on it, applying writes so a second run sees the first. */
function fakeGithub(seed: { labels?: string[]; reviewers?: string[]; reviews?: string[]; approvals?: FakeReview[]; comments?: FakeComment[] } = {}) {
  const pr = { state: "open", merged: false, mergeable: true, head: { sha: "abc" }, labels: (seed.labels ?? []).map((name) => ({ name })), assignees: [], requested_reviewers: (seed.reviewers ?? []).map((login) => ({ login })) };
  const comments = seed.comments ?? [];
  const reviews: FakeReview[] = [...(seed.reviews ?? []).map((login, index) => ({ id: index + 1, user: { login, type: "User" }, state: "APPROVED", commit_id: "abc" })), ...(seed.approvals ?? [])];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  async function gh(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ method, path, body });
    if (path.endsWith("/pulls/8")) {
      if (method === "PATCH") pr.state = body.state;
      return Response.json(pr);
    }
    if (path === "/app") return Response.json({ slug: "corbits-triage" });
    if (path.endsWith("/pulls/8/reviews")) {
      reviews.push({ id: reviews.length + 100, user: APP, state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: body.commit_id, body: body.body });
      return Response.json(reviews.at(-1));
    }
    if (path.includes("/pulls/8/reviews?")) return Response.json(reviews);
    if (path.endsWith("/dismissals")) {
      const review = reviews.find((r) => path.includes(`/reviews/${r.id}/`))!;
      review.state = "DISMISSED";
      return Response.json(review);
    }
    if (path.includes("/issues/8/comments?")) return Response.json(comments);
    if (path.endsWith("/issues/8/comments")) {
      comments.push({ id: comments.length + 1, user: APP, body: body.body });
      return Response.json(comments.at(-1));
    }
    if (path.endsWith("/issues/8/labels")) {
      pr.labels.push(...body.labels.map((name: string) => ({ name })));
      return Response.json(pr.labels);
    }
    if (method === "DELETE" && path.includes("/issues/8/labels/")) {
      const name = decodeURIComponent(path.split("/").at(-1)!);
      pr.labels = pr.labels.filter((label) => label.name !== name);
      return Response.json(pr.labels);
    }
    if (method === "PUT" && path.endsWith("/pulls/8/merge")) {
      pr.merged = true;
      pr.state = "closed";
      return Response.json({ merged: true, sha: "merged" });
    }
    if (path.endsWith("/pulls/8/requested_reviewers")) {
      pr.requested_reviewers.push(...body.reviewers.map((login: string) => ({ login })));
      return Response.json(pr);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
  return { gh: gh satisfies GithubFetch, writes };
}

function step(kind: DoStep["kind"], target: ResolvedTarget): DoStep {
  return { effectId: "e1", headSha: "abc", kind, target };
}

const REQUEST = { repo: "acme/widgets", number: 8, labels: ["triage:blocked"], owned: ["triage:blocked"], comment: "Blocked" };

function run(gh: GithubFetch, task: DoStep) {
  return executeDo(gh, { request: REQUEST, step: task }, function login() {
    return appLogin(gh);
  });
}

describe("executeDo", () => {
  test("labels already on the pull request write nothing", async () => {
    const { gh, writes } = fakeGithub({ labels: ["API"] });
    expect(await run(gh, step("labels", { labels: ["api"] }))).toMatchObject({ status: "satisfied" });
    expect(writes).toEqual([]);
  });

  test("a missing label is written once", async () => {
    const { gh, writes } = fakeGithub({ labels: ["api"] });
    const task = step("labels", { labels: ["api", "search"] });
    expect(await run(gh, task)).toMatchObject({ status: "done" });
    expect(await run(gh, task)).toMatchObject({ status: "satisfied" });
    expect(writes).toEqual([{ method: "POST", path: "/repos/acme/widgets/issues/8/labels", body: { labels: ["search"] } }]);
  });

  test("derived labels add what applies and take back what no longer does, once", async () => {
    const { gh, writes } = fakeGithub({ labels: ["api", "triage: fail"] });
    const task = step("labels", { labels: ["triage: pass"], unlabel: ["triage: fail", "triage: unsure"] });
    expect(await run(gh, task)).toMatchObject({ status: "done" });
    expect(await run(gh, task)).toMatchObject({ status: "satisfied" });
    expect(writes).toEqual([
      { method: "POST", path: "/repos/acme/widgets/issues/8/labels", body: { labels: ["triage: pass"] } },
      { method: "DELETE", path: "/repos/acme/widgets/issues/8/labels/triage%3A%20fail", body: null },
    ]);
  });

  test("a merge merges the verdict's head once", async () => {
    const { gh, writes } = fakeGithub();
    expect(await run(gh, step("merge", {}))).toMatchObject({ status: "done", result: { merged: true } });
    expect(await run(gh, step("merge", {}))).toMatchObject({ status: "satisfied" });
    expect(writes).toEqual([{ method: "PUT", path: "/repos/acme/widgets/pulls/8/merge", body: { sha: "abc" } }]);
  });

  test("a reviewer requested or reviewed on this head is not asked again", async () => {
    const { gh, writes } = fakeGithub({ reviewers: ["alice"], reviews: ["bob"] });
    const task = step("request-review", { users: ["alice", "bob", "carol"], teams: [] });
    expect(await run(gh, task)).toMatchObject({ status: "done" });
    expect(await run(gh, task)).toMatchObject({ status: "satisfied" });
    expect(writes).toEqual([{ method: "POST", path: "/repos/acme/widgets/pulls/8/requested_reviewers", body: { reviewers: ["carol"], team_reviewers: [] } }]);
  });

  test("a comment carries its marker and is posted once", async () => {
    const { gh, writes } = fakeGithub();
    const task = step("comment", { body: "Thanks" });
    expect(await run(gh, task)).toMatchObject({ status: "done" });
    expect(await run(gh, task)).toEqual({ status: "satisfied", result: { commentId: 1 } });
    expect(writes).toEqual([{ method: "POST", path: "/repos/acme/widgets/issues/8/comments", body: { body: `${doMarker("e1")}\nThanks` } }]);
  });

  test("a person's comment with the marker does not count as posted", async () => {
    const { gh, writes } = fakeGithub({ comments: [{ id: 7, user: { login: "mallory", type: "User" }, body: doMarker("e1") }] });
    expect(await run(gh, step("comment", { body: "Thanks" }))).toMatchObject({ status: "done" });
    expect(writes).toHaveLength(1);
  });

  test("a close sends the verdict's labels and comment, as the pane's Close does, once", async () => {
    const { gh, writes } = fakeGithub();
    expect(await run(gh, step("close", {}))).toMatchObject({ status: "done" });
    expect(await run(gh, step("close", {}))).toMatchObject({ status: "satisfied" });
    expect(writes).toEqual([
      { method: "POST", path: "/repos/acme/widgets/issues/8/comments", body: { body: "<!-- corbits-triage -->\nBlocked" } },
      { method: "POST", path: "/repos/acme/widgets/issues/8/labels", body: { labels: ["triage:blocked"] } },
      { method: "PATCH", path: "/repos/acme/widgets/pulls/8", body: { state: "closed" } },
    ]);
  });

  test("an approval is pinned to the verdict's head, marked as the Do's, and made once", async () => {
    const { gh, writes } = fakeGithub();
    expect(await run(gh, step("approve", {}))).toMatchObject({ status: "done" });
    expect(await run(gh, step("approve", {}))).toEqual({ status: "satisfied", result: { reviewId: 100 } });
    expect(writes).toEqual([{ method: "POST", path: "/repos/acme/widgets/pulls/8/reviews", body: { body: APPROVE_DO_MARKER, event: "APPROVE", commit_id: "abc" } }]);
  });

  test("changes are requested on the verdict's head with their list, once, and a later approval still stands over them", async () => {
    const { gh, writes } = fakeGithub();
    const task = step("request-changes", { body: "Triage requests changes:\n- CI: CI failed" });
    expect(await run(gh, task)).toMatchObject({ status: "done" });
    expect(await run(gh, task)).toEqual({ status: "satisfied", result: { reviewId: 100 } });
    expect(await run(gh, step("approve", {}))).toMatchObject({ status: "done" });
    expect(writes).toEqual([
      { method: "POST", path: "/repos/acme/widgets/pulls/8/reviews", body: { body: `${REQUEST_CHANGES_DO_MARKER}\nTriage requests changes:\n- CI: CI failed`, event: "REQUEST_CHANGES", commit_id: "abc" } },
      { method: "POST", path: "/repos/acme/widgets/pulls/8/reviews", body: { body: APPROVE_DO_MARKER, event: "APPROVE", commit_id: "abc" } },
    ]);
  });

  test.each<[string, FakeReview]>([
    ["an approval of this head from the inbox", { id: 3, user: APP, state: "APPROVED", commit_id: "abc" }],
    ["an approval of this head a person dismissed", { id: 3, user: APP, state: "DISMISSED", commit_id: "abc" }],
  ])("the App does not approve again over %s", async (_, approval) => {
    const { gh, writes } = fakeGithub({ approvals: [approval] });
    expect(await run(gh, step("approve", {}))).toEqual({ status: "satisfied", result: { reviewId: 3 } });
    expect(writes).toEqual([]);
  });

  test("another bot's or an earlier head's approval does not count as the App's", async () => {
    const other = { id: 3, user: { login: "renovate[bot]", type: "Bot" }, state: "APPROVED", commit_id: "abc" };
    const earlier = { id: 4, user: APP, state: "APPROVED", commit_id: "older" };
    const { gh, writes } = fakeGithub({ approvals: [other, earlier] });
    expect(await run(gh, step("approve", {}))).toMatchObject({ status: "done" });
    expect(writes).toHaveLength(1);
  });

  test.each<[string, DoStep]>([
    ["a comment", step("comment", { body: "Thanks" })],
    ["a close", step("close", {})],
    ["a merge", step("merge", {})],
    ["an approval", step("approve", {})],
    ["a request for changes", step("request-changes", { body: "Triage requests changes:\n- CI: CI failed" })],
  ])("%s is not written once the pull request has moved on", async (_, task) => {
    const { gh, writes } = fakeGithub();
    await expect(run(gh, { ...task, headSha: "older" })).rejects.toBeInstanceOf(HeadMovedError);
    expect(writes).toEqual([]);
  });
});
