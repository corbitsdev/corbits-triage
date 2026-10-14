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

async function login() {
  return APP.login;
}

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
    const second = await mirror(gh, { ...MIRROR, comment: "Second", close: false }, login);
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
    await mirror(gh, { ...MIRROR, close: false }, login);
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
    await mirror(gh, { ...MIRROR, comment: "Please resolve conflicts", close: false }, login);
    await mirror(gh, { ...MIRROR, comment: "", close: false }, login);
    expect(comments).toEqual([other]);
  });

  test("no comment leaves the triage comment as it is", async () => {
    const ours = { id: 42, user: APP, body: "<!-- corbits-triage -->\nKept" };
    const { gh, comments } = fakeGithub([{ ...ours }]);
    const { comment: _comment, ...labelsOnly } = MIRROR;
    await mirror(gh, { ...labelsOnly, close: false }, login);
    expect(comments).toEqual([ours]);
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
    await mirror(gh, { ...MIRROR, close: true }, login);
    expect(requests).toContainEqual({ path: "/repos/acme/widgets/pulls/8", method: "PATCH", body: { state: "closed" } });
    expect(requests.some((request) => request.path.includes("/merge"))).toBe(false);
  });

  test("swaps a stale triage label and leaves a foreign label alone", async () => {
    const { gh, requests } = fakeGithub([], [], ["bug", "triage:blocked"]);
    await mirror(gh, { ...MIRROR, comment: "", close: false }, login);
    expect(requests.filter((request) => request.path.includes("/labels"))).toEqual([
      { path: "/repos/acme/widgets/issues/8/labels", method: "POST", body: { labels: ["triage:needs-decision"] } },
      { path: "/repos/acme/widgets/issues/8/labels/triage%3Ablocked", method: "DELETE", body: null },
    ]);
  });

  test("without owned adds the missing label and removes nothing", async () => {
    const { gh, requests } = fakeGithub([], [], ["triage:blocked"]);
    await mirror(gh, { ...MIRROR, owned: undefined, comment: "", close: false }, login);
    expect(requests.filter((request) => request.path.includes("/labels"))).toEqual([
      { path: "/repos/acme/widgets/issues/8/labels", method: "POST", body: { labels: ["triage:needs-decision"] } },
    ]);
  });

  test("makes no label requests when the labels already match", async () => {
    const { gh, requests } = fakeGithub([], [], ["bug", "triage:needs-decision"]);
    await mirror(gh, { ...MIRROR, comment: "", close: false }, login);
    expect(requests.some((request) => request.path.includes("/labels"))).toBe(false);
  });
});

type TimedComment = FakeComment & { updated_at: string };

/** GitHub holding alice's pull request 8, stamping each comment write, so reruns read what earlier ones wrote and when. */
function timedGithub(state = "open", seed: TimedComment[] = []) {
  let clock = 0;
  const pr = { state, user: { login: "alice" }, head: { sha: "abc" }, labels: [] as Array<{ name: string }> };
  const comments = [...seed];
  function tick() {
    return new Date(Date.UTC(2026, 9, 13, 0, 0, clock++)).toISOString();
  }
  const { gh, requests } = recorder(function respond(path, init) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (path.endsWith("/pulls/8") && !init?.method) return pr;
    if (path.includes("/comments?per_page")) return comments;
    if (path.endsWith("/issues/8/labels") && init?.method === "POST") return pr.labels.push(...body.labels.map((name: string) => ({ name })));
    if (path.endsWith("/issues/8/comments") && init?.method === "POST") {
      comments.push({ id: comments.length + 100, user: APP, body: body.body, updated_at: tick() });
      return comments.at(-1);
    }
    const edit = /\/issues\/comments\/(\d+)$/.exec(path);
    const target = comments.find((comment) => comment.id === Number(edit?.[1]) && comment.user.login === APP.login);
    if (target && init?.method === "PATCH") return Object.assign(target, { body: body.body, updated_at: tick() });
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  function writes() {
    return requests.filter((request) => request.method !== "GET");
  }
  function authorComments() {
    comments.push({ id: comments.length + 100, user: { login: "alice", type: "User" }, body: "Fixed", updated_at: tick() });
  }
  return { gh, comments, writes, authorComments };
}

const POLICY_V1 = { repo: { id: "policy-1", version: 1 } };
const POLICY_V2 = { repo: { id: "policy-1", version: 2 } };
const PASSED = { repo: "acme/widgets", number: 8, labels: ["Triage: Ready"], owned: ["Triage: Ready", "Triage: Not Ready"], comment: "Passes.", close: false, header: { head: "abc", policy: POLICY_V1, verdict: "pass" } };
const PASSED_BODY = `<!-- corbits-triage {"head":"abc","policy":{"repo":{"id":"policy-1","version":1}},"verdict":"pass"} -->\nPasses.`;

describe("triage comment on a rerun", () => {
  test("the same head, policy, verdict and text writes nothing, not even an edit, even after the author spoke, and says since when", async () => {
    const github = timedGithub();
    await mirror(github.gh, PASSED, login);
    github.authorComments();
    const before = github.writes().length;
    expect(await mirror(github.gh, PASSED, login)).toMatchObject({ commentId: 100, updated: false, unchanged: "unchanged since 2026-10-13T00:00:00.000Z" });
    expect(github.writes()).toHaveLength(before);
    expect(github.comments[0]!.body).toBe(PASSED_BODY);
  });

  test("a moved head updates the comment in place", async () => {
    const github = timedGithub();
    await mirror(github.gh, PASSED, login);
    expect(await mirror(github.gh, { ...PASSED, header: { ...PASSED.header, head: "def" } }, login)).toMatchObject({ commentId: 100, updated: true });
    expect(github.writes().map((write) => `${write.method} ${write.path}`)).toEqual([
      "POST /repos/acme/widgets/issues/8/comments",
      "POST /repos/acme/widgets/issues/8/labels",
      "PATCH /repos/acme/widgets/issues/comments/100",
    ]);
  });

  test("new rules changing the verdict on the same head supersede the comment, and a rerun then stays quiet", async () => {
    const github = timedGithub();
    await mirror(github.gh, PASSED, login);
    const failed = { ...PASSED, comment: "Fails: CI.", header: { head: "abc", policy: POLICY_V2, verdict: "fail" } };
    await mirror(github.gh, failed, login);
    const before = github.writes().length;
    await mirror(github.gh, failed, login);
    expect(github.writes()).toHaveLength(before);
    expect(github.comments.map((comment) => comment.body)).toEqual([
      `<!-- corbits-triage-superseded {"head":"abc","policy":{"repo":{"id":"policy-1","version":1}},"verdict":"pass"} -->\nSuperseded by the comment below.`,
      `<!-- corbits-triage {"head":"abc","policy":{"repo":{"id":"policy-1","version":2}},"verdict":"fail"} -->\nThis supersedes the comment above because the rules changed: repository policy version 1 → version 2.\n\nFails: CI.`,
    ]);
  });

  test("another bot's byte-copied marker and header is ignored, and Triage posts its own", async () => {
    const forged = { id: 7, user: { login: "github-actions[bot]", type: "Bot" }, body: PASSED_BODY, updated_at: "2026-10-12T00:00:00.000Z" };
    const github = timedGithub("open", [forged]);
    expect(await mirror(github.gh, PASSED, login)).toMatchObject({ commentId: 101, updated: false });
    expect(github.writes().filter((write) => write.path.includes("comments"))).toEqual([{ path: "/repos/acme/widgets/issues/8/comments", method: "POST", body: { body: PASSED_BODY } }]);
  });

  test("a closed or merged pull request is never written to, labels included", async () => {
    const github = timedGithub("closed");
    expect(await mirror(github.gh, PASSED, login)).toMatchObject({ skipped: "the pull request is not open" });
    expect(await mirror(github.gh, { ...PASSED, comment: "" }, login)).toMatchObject({ skipped: "the pull request is not open" });
    expect(github.writes()).toEqual([]);
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
