import { describe, expect, test } from "bun:test";
import { githubWrite } from "./sidecar-bundle.js";
import { type GithubFetch } from "@corbits/github-reads";
import { mergePr, mirror, upsertTriageComment } from "./github.js";

type RecordedRequest = { path: string; method: string; body: unknown };

function recorder(respond: (path: string, init?: RequestInit) => unknown) {
  const requests: RecordedRequest[] = [];
  async function gh(path: string, init?: RequestInit): Promise<Response> {
    requests.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const reply = respond(path, init);
    return reply instanceof Response ? reply : Response.json(reply);
  }
  return { gh: gh satisfies GithubFetch, requests };
}

type FakeComment = { id: number; user: { login: string; type: string }; body: string };

const APP = { login: "corbits-triage[bot]", type: "Bot" };

/** GitHub that keeps pull request 8's issue comments, so repeated runs see each other's writes. */
function fakeGithub(comments: FakeComment[] = [], otherAppComments: number[] = [], labels: string[] = []) {
  let nextId = 100;
  const { gh, requests } = recorder(function respond(path, init) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body).body : undefined;
    if (path.endsWith("/pulls/8") && !init?.method) return { state: "open", head: { sha: "abc123" }, labels: labels.map((name) => ({ name })) };
    if (path.includes("/comments?per_page")) return comments;
    if (path.endsWith("/issues/8/comments") && init?.method === "POST") {
      const created = { id: nextId++, user: APP, body };
      comments.push(created);
      return created;
    }
    const edit = /\/issues\/comments\/(\d+)$/.exec(path);
    if (edit && init?.method === "DELETE") {
      if (otherAppComments.includes(Number(edit[1]))) return Response.json({ message: "Forbidden" }, { status: 403 });
      comments.splice(comments.findIndex((comment) => comment.id === Number(edit[1])), 1);
      return new Response(null, { status: 204 });
    }
    if (edit && init?.method === "PATCH") {
      if (otherAppComments.includes(Number(edit[1]))) return Response.json({ message: "Forbidden" }, { status: 403 });
      const target = comments.find((comment) => comment.id === Number(edit[1]));
      if (!target) throw new Error(`no comment ${edit[1]}`);
      target.body = body;
      return target;
    }
    return { id: 1 };
  });
  return { gh, requests, comments };
}

const MIRROR = { repo: "acme/widgets", number: 8, labels: ["triage:needs-decision"], owned: ["triage:needs-decision", "triage:blocked"], comment: "Duplicate" };

describe("triage comment", () => {
  test("first run creates it, later runs edit the same one", async () => {
    const { gh, comments } = fakeGithub();
    const first = await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "First" });
    const second = await mirror(gh, { ...MIRROR, comment: "Second", close: false });
    const third = await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "Third" });
    expect(first).toEqual({ commentId: 100, updated: false });
    expect(second).toMatchObject({ commentId: 100, updated: true });
    expect(third).toEqual({ commentId: 100, updated: true });
    expect(comments).toEqual([{ id: 100, user: APP, body: "<!-- corbits-triage -->\nThird" }]);
  });

  test("edits a comment carrying the earlier per-head marker", async () => {
    const { gh, requests, comments } = fakeGithub([
      { id: 42, user: APP, body: "<!-- corbits-triage:acme/widgets#8@old -->\nOld" },
    ]);
    await mirror(gh, { ...MIRROR, close: false });
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/comments"))).toBe(false);
    expect(comments).toEqual([{ id: 42, user: APP, body: "<!-- corbits-triage -->\nDuplicate" }]);
  });

  test("ignores a marked comment written by a person", async () => {
    const foreign = { id: 7, user: { login: "mallory", type: "User" }, body: "<!-- corbits-triage -->\nNot ours" };
    const { gh, comments } = fakeGithub([{ ...foreign }]);
    expect(await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "Ours" })).toEqual({ commentId: 100, updated: false });
    expect(comments).toEqual([foreign, { id: 100, user: APP, body: "<!-- corbits-triage -->\nOurs" }]);
  });

  test("an empty comment deletes the stale one and leaves another App's", async () => {
    const other = { id: 9, user: { login: "other-app[bot]", type: "Bot" }, body: "<!-- corbits-triage -->\nTheirs" };
    const { gh, comments } = fakeGithub([{ ...other }], [9]);
    await mirror(gh, { ...MIRROR, comment: "Please resolve conflicts", close: false });
    await mirror(gh, { ...MIRROR, comment: "", close: false });
    expect(comments).toEqual([other]);
  });

  test("creates its own when GitHub refuses to edit another App's marked comment", async () => {
    const other = { id: 9, user: { login: "other-app[bot]", type: "Bot" }, body: "<!-- corbits-triage -->\nTheirs" };
    const { gh, requests, comments } = fakeGithub([{ ...other }], [9]);
    expect(await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "Ours" })).toEqual({ commentId: 100, updated: false });
    expect(requests.some((request) => request.path === "/repos/acme/widgets/issues/comments/9" && request.method === "PATCH")).toBe(true);
    expect(comments).toEqual([other, { id: 100, user: APP, body: "<!-- corbits-triage -->\nOurs" }]);
  });
});

describe("github mirror", () => {
  test("close:true closes and never merges", async () => {
    const { gh, requests } = fakeGithub();
    await mirror(gh, { ...MIRROR, close: true });
    expect(requests).toContainEqual({ path: "/repos/acme/widgets/pulls/8", method: "PATCH", body: { state: "closed" } });
    expect(requests.some((request) => request.path.includes("/merge"))).toBe(false);
  });

  test("swaps a stale triage label and leaves a foreign label alone", async () => {
    const { gh, requests } = fakeGithub([], [], ["bug", "triage:blocked"]);
    await mirror(gh, { ...MIRROR, comment: "", close: false });
    expect(requests.filter((request) => request.path.includes("/labels"))).toEqual([
      { path: "/repos/acme/widgets/issues/8/labels", method: "POST", body: { labels: ["triage:needs-decision"] } },
      { path: "/repos/acme/widgets/issues/8/labels/triage%3Ablocked", method: "DELETE", body: null },
    ]);
  });

  test("without owned adds the missing label and removes nothing", async () => {
    const { gh, requests } = fakeGithub([], [], ["triage:blocked"]);
    await mirror(gh, { ...MIRROR, owned: undefined, comment: "", close: false });
    expect(requests.filter((request) => request.path.includes("/labels"))).toEqual([
      { path: "/repos/acme/widgets/issues/8/labels", method: "POST", body: { labels: ["triage:needs-decision"] } },
    ]);
  });

  test("makes no label requests when the labels already match", async () => {
    const { gh, requests } = fakeGithub([], [], ["bug", "triage:needs-decision"]);
    await mirror(gh, { ...MIRROR, comment: "", close: false });
    expect(requests.some((request) => request.path.includes("/labels"))).toBe(false);
  });
});

describe("github write tool approval", () => {
  test("every write except the automatic ones asks", () => {
    expect(githubWrite.definitions).toEqual([
      { name: "github_mirror", approval: "ask" },
      { name: "github_mirror_auto" },
      { name: "github_execute_do_auto" },
      { name: "github_create_review", approval: "ask" },
      { name: "github_create_issue_comment", approval: "ask" },
      { name: "github_add_assignees", approval: "ask" },
      { name: "github_request_reviewers", approval: "ask" },
      { name: "github_merge_pr", approval: "ask" },
    ]);
  });
});

describe("mergePr", () => {
  test("PUTs merge when GitHub reports mergeable", async () => {
    const { gh, requests } = recorder(function respond(path, init) {
      if (init?.method === "PUT") return { merged: true, sha: "abc123" };
      return { mergeable: true, head: { sha: "abc123" }, state: "open" };
    });
    expect(await mergePr(gh, { repo: "acme/widgets", number: 8 })).toEqual({ merged: true, sha: "abc123" });
    expect(requests).toEqual([
      { path: "/repos/acme/widgets/pulls/8", method: "GET", body: null },
      { path: "/repos/acme/widgets/pulls/8/merge", method: "PUT", body: { sha: "abc123" } },
    ]);
  });

  test("merges only the head it was given", async () => {
    const { gh, requests } = recorder(function respond(path, init) {
      if (init?.method === "PUT") return { merged: true, sha: "checked" };
      return { mergeable: true, head: { sha: "newer" }, state: "open" };
    });
    await mergePr(gh, { repo: "acme/widgets", number: 8, sha: "checked" });
    expect(requests.at(-1)).toEqual({ path: "/repos/acme/widgets/pulls/8/merge", method: "PUT", body: { sha: "checked" } });
  });

  test("refuses when not mergeable and does not PUT", async () => {
    const { gh, requests } = recorder(function respond() {
      return { mergeable: false, head: { sha: "abc123" }, state: "open" };
    });
    await expect(mergePr(gh, { repo: "acme/widgets", number: 8 })).rejects.toThrow("pull request is not mergeable");
    expect(requests).toEqual([{ path: "/repos/acme/widgets/pulls/8", method: "GET", body: null }]);
  });
});
