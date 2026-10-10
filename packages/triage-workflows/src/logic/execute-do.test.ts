import { describe, expect, test } from "bun:test";
import type { GithubFetch } from "@corbits/github-tool/github";
import type { ResolvedTarget, SuggestedDo } from "./actions.js";
import { DoNotRunnableError, doMarker, executeDo } from "./execute-do.js";

type FakeComment = { id: number; user: { login: string; type: string }; body: string };

const APP = { login: "corbits-triage[bot]", type: "Bot" };

/** GitHub holding pull request 8, applying writes so a second run sees the first. */
function fakeGithub(seed: { labels?: string[]; reviewers?: string[]; reviews?: string[]; comments?: FakeComment[] } = {}) {
  const pr = { state: "open", head: { sha: "abc" }, labels: (seed.labels ?? []).map((name) => ({ name })), assignees: [], requested_reviewers: (seed.reviewers ?? []).map((login) => ({ login })) };
  const comments = seed.comments ?? [];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  async function gh(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ method, path, body });
    if (path.endsWith("/pulls/8")) {
      if (method === "PATCH") pr.state = body.state;
      return Response.json(pr);
    }
    if (path.includes("/pulls/8/reviews")) return Response.json((seed.reviews ?? []).map((login) => ({ user: { login }, state: "APPROVED", commit_id: "abc" })));
    if (path.includes("/issues/8/comments?")) return Response.json(comments);
    if (path.endsWith("/issues/8/comments")) {
      comments.push({ id: comments.length + 1, user: APP, body: body.body });
      return Response.json(comments.at(-1));
    }
    if (path.endsWith("/issues/8/labels")) {
      pr.labels.push(...body.labels.map((name: string) => ({ name })));
      return Response.json(pr.labels);
    }
    if (path.endsWith("/pulls/8/requested_reviewers")) {
      pr.requested_reviewers.push(...body.reviewers.map((login: string) => ({ login })));
      return Response.json(pr);
    }
    throw new Error(`unexpected ${method} ${path}`);
  }
  return { gh: gh satisfies GithubFetch, writes };
}

function step(kind: SuggestedDo["kind"], target: ResolvedTarget): SuggestedDo {
  return { id: "a", branch: "always", index: 0, effectId: "e1", kind, automatic: false, reason: "", target };
}

const REQUEST = { repo: "acme/widgets", number: 8, labels: ["triage:blocked"], owned: ["triage:blocked"], comment: "Blocked", close: false };

function run(gh: GithubFetch, task: SuggestedDo) {
  return executeDo(gh, { request: REQUEST, step: task });
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

  test.each<[string, SuggestedDo]>([
    ["agent Dos", step("agent", { prompt: "fix it", tools: [] })],
    ["derived labels", step("labels", { unresolved: "derive", from: "type" })],
  ])("%s are not runnable", async (_, task) => {
    const { gh, writes } = fakeGithub();
    await expect(run(gh, task)).rejects.toBeInstanceOf(DoNotRunnableError);
    expect(writes).toEqual([]);
  });
});
