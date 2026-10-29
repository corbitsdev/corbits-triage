import { describe, expect, test } from "bun:test";
import { githubCalls, githubWrite } from "./sidecar-bundle.js";
import { type GithubFetch } from "@corbits/github-reads";
import { findingThreadStates, mergePr, mirror, sendCodeReview, upsertTriageComment } from "./github.js";

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

const login = APP.login;

function fakeGithub(comments: FakeComment[] = [], labels: string[] = []) {
  let nextId = 100;
  const { gh, requests } = recorder(function respond(path, init) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body).body : undefined;
    if (path.endsWith("/pulls/8") && !init?.method) return { state: "open", head: { sha: "abc123" }, base: { repo: { id: 1 } }, labels: labels.map((name) => ({ name })) };
    if (path.includes("/comments?per_page")) return comments;
    if (path.endsWith("/issues/8/comments") && init?.method === "POST") {
      const created = { id: nextId++, user: APP, body };
      comments.push(created);
      return created;
    }
    const edit = /\/issues\/comments\/(\d+)$/.exec(path);
    if (edit && init?.method === "DELETE") {
      comments.splice(comments.findIndex((comment) => comment.id === Number(edit[1])), 1);
      return new Response(null, { status: 204 });
    }
    if (edit && init?.method === "PATCH") {
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
    const first = await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "First" }, login);
    const second = await mirror(gh, { ...MIRROR, comment: "Second", close: false }, login);
    const third = await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "Third" }, login);
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
    expect(await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "Ours" }, login)).toEqual({ commentId: 100, updated: false });
    expect(comments).toEqual([foreign, { id: 100, user: APP, body: "<!-- corbits-triage -->\nOurs" }]);
  });

  test("an empty comment deletes the stale one and leaves another App's that GitHub would let it delete", async () => {
    const other = { id: 9, user: { login: "other-app[bot]", type: "Bot" }, body: "<!-- corbits-triage -->\nTheirs" };
    const { gh, comments } = fakeGithub([{ ...other }]);
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

  test("creates its own and leaves another App's marked comment that GitHub would let it edit", async () => {
    const other = { id: 9, user: { login: "other-app[bot]", type: "Bot" }, body: "<!-- corbits-triage -->\nTheirs" };
    const { gh, comments } = fakeGithub([{ ...other }]);
    expect(await upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "Ours" }, login)).toEqual({ commentId: 100, updated: false });
    expect(comments).toEqual([other, { id: 100, user: APP, body: "<!-- corbits-triage -->\nOurs" }]);
  });

  test("progress over CI progress written over a verdict writes, though the verdict and policy are the same", async () => {
    const verdict = `<!-- corbits-triage ${JSON.stringify({ head: "abc123", policy: null, verdict: "pass" })} -->\n**Triage: Pass**`;
    const progress = { ...MIRROR, onHead: "abc123", close: false };
    const { gh, comments } = fakeGithub([{ id: 42, user: APP, body: verdict }]);
    await mirror(gh, { ...progress, comment: "**Triage: In progress**\n\nwaiting for CI" }, login);
    expect(await mirror(gh, { ...progress, comment: "**Triage: In progress**\n\nwaiting for code review", keepVerdict: { verdict: "pass", policy: null } }, login)).toMatchObject({ commentId: 42, updated: true });
    expect(comments[0]!.body).toEndWith("waiting for code review");
  });

  test("progress over a verdict made under another policy writes, though the verdict is the same", async () => {
    const header = { head: "abc123", policy: { repo: { id: "art_policy", version: 1 } }, verdict: "fail" };
    const { gh, comments } = fakeGithub([{ id: 42, user: APP, body: `<!-- corbits-triage ${JSON.stringify(header)} -->\n**Triage: Fail**` }]);
    const keepVerdict = { verdict: "fail", policy: { repo: { id: "art_policy", version: 2 } } };
    expect(await mirror(gh, { ...MIRROR, comment: "**Triage: In progress**", onHead: "abc123", keepVerdict, close: false }, login)).toMatchObject({ commentId: 42, updated: true });
    expect(comments[0]!.body).toEndWith("\n**Triage: In progress**");
  });

  test("progress keeps a verdict on the head only while it is the pass's verdict", async () => {
    const verdict = `<!-- corbits-triage ${JSON.stringify({ head: "abc123", policy: null, verdict: "fail" })} -->\n**Triage: Fail**`;
    const progress = { ...MIRROR, comment: "**Triage: In progress**", onHead: "abc123", close: false };
    const { gh, comments } = fakeGithub([{ id: 42, user: APP, body: verdict }]);
    expect(await mirror(gh, { ...progress, keepVerdict: { verdict: "fail", policy: null } }, login)).toMatchObject({ commentId: 42, updated: false, kept: "verdict" });
    expect(comments[0]!.body).toBe(verdict);
    expect(await mirror(gh, { ...progress, keepVerdict: { verdict: "pass", policy: null } }, login)).toMatchObject({ commentId: 42, updated: true });
    expect(comments[0]!.body).toEndWith("\n**Triage: In progress**");
  });

  test("a refused edit of its own comment throws and posts nothing", async () => {
    const ours = { id: 42, user: APP, body: "<!-- corbits-triage -->\nOld" };
    const { gh, requests } = recorder(function respond(path, init) {
      if (path.includes("/comments?per_page")) return [ours];
      if (init?.method === "PATCH") return Response.json({ message: "Forbidden" }, { status: 403 });
      return { id: 1 };
    });
    await expect(upsertTriageComment(gh, { repo: "acme/widgets", number: 8, body: "New" }, login)).rejects.toThrow("-> 403");
    expect(requests.some((request) => request.method === "POST")).toBe(false);
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
    const { gh, requests } = fakeGithub([], ["bug", "triage:blocked"]);
    await mirror(gh, { ...MIRROR, comment: "", close: false }, login);
    expect(requests.filter((request) => request.path.includes("/labels"))).toEqual([
      { path: "/repos/acme/widgets/issues/8/labels", method: "POST", body: { labels: ["triage:needs-decision"] } },
      { path: "/repos/acme/widgets/issues/8/labels/triage%3Ablocked", method: "DELETE", body: null },
    ]);
  });

  test("without owned adds the missing label and removes nothing", async () => {
    const { gh, requests } = fakeGithub([], ["triage:blocked"]);
    await mirror(gh, { ...MIRROR, owned: undefined, comment: "", close: false }, login);
    expect(requests.filter((request) => request.path.includes("/labels"))).toEqual([
      { path: "/repos/acme/widgets/issues/8/labels", method: "POST", body: { labels: ["triage:needs-decision"] } },
    ]);
  });

  test("makes no label requests when the labels already match", async () => {
    const { gh, requests } = fakeGithub([], ["bug", "triage:needs-decision"]);
    await mirror(gh, { ...MIRROR, comment: "", close: false }, login);
    expect(requests.some((request) => request.path.includes("/labels"))).toBe(false);
  });
});

type TimedComment = FakeComment & { updated_at: string };

function timedGithub(state = "open", seed: TimedComment[] = []) {
  let clock = 0;
  const pr = { state, user: { login: "alice" }, head: { sha: "abc" }, base: { repo: { id: 1 } }, labels: [] as Array<{ name: string }> };
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

  test("a changed policy file of the repository the policy extends supersedes the comment", async () => {
    const github = timedGithub();
    const file = { path: ".corbits-triage.yml", sha: "1111111aaa" };
    const before = { ...PASSED, header: { head: "abc", policy: { file, sharedFile: { repo: "acme/shared", ...file } }, verdict: "pass" } };
    await mirror(github.gh, before, login);
    await mirror(github.gh, { ...before, comment: "Fails: CI.", header: { head: "abc", policy: { file, sharedFile: { repo: "acme/shared", path: file.path, sha: "2222222bbb" } }, verdict: "fail" } }, login);
    expect(github.comments.at(-1)!.body).toContain("This supersedes the comment above because the rules changed: acme/shared policy file 1111111 → 2222222.");
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
      { name: "github_send_code_review", approval: "ask" },
      { name: "github_merge_pr", approval: "ask" },
    ]);
  });
});

describe("github tool arguments", () => {
  test("a repository, number, sha, ref or author that would leave its API path is refused before any request", async () => {
    const { gh, requests } = recorder(function respond() {
      return {};
    });
    const run = githubCalls(async () => gh);
    const step = { effectId: "e1", headSha: "abc", kind: "comment", target: { body: "Hi" } };
    const refused: Array<[string, Record<string, unknown>]> = [
      ["github_get_pr", { repo: "acme/../../user", number: 1 }],
      ["github_get_pr", { repo: "acme/./widgets", number: 1 }],
      ["github_get_pr", { repo: "acme/widgets?x=1", number: 1 }],
      ["github_get_pr", { repo: "acme/widgets", number: "1/merge" }],
      ["github_get_checks", { repo: "acme/widgets", sha: ".." }],
      ["github_get_checks", { repo: "acme/widgets", sha: "main/../../x" }],
      ["github_read_repo_docs", { repo: "acme/widgets", ref: ".." }],
      ["github_read_repo_docs", { repo: "acme/widgets", ref: "." }],
      ["github_author_teams", { repo: "acme/widgets", author: "..", teams: ["core"] }],
      ["github_execute_do_auto", { request: { repo: "acme/w/../../x", number: 1, labels: [], comment: "" }, step }],
    ];
    for (const [name, args] of refused) expect(await run({ id: "c", name, arguments: args })).toMatchObject({ isError: true });
    expect(requests).toEqual([]);
    expect(await run({ id: "c", name: "github_nope", arguments: {} })).toMatchObject({ isError: true, content: "unknown tool github_nope" });
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

  test("a merge the branch's rules refuse fails with GitHub's own reason", async () => {
    const reason = "At least 1 approving review is required by reviewers with write access.";
    const { gh } = recorder(function respond(_path, init) {
      if (init?.method === "PUT") return Response.json({ message: reason }, { status: 405 });
      return { mergeable: true, mergeable_state: "blocked", head: { sha: "abc123" }, state: "open" };
    });
    await expect(mergePr(gh, { repo: "acme/widgets", number: 8 })).rejects.toThrow(`github PUT /repos/acme/widgets/pulls/8/merge -> 405 ${reason}`);
  });
});

describe("sendCodeReview", () => {
  const PATCH = "@@ -10,3 +10,4 @@\n ten\n-old\n+new\n+added\n twelve\n@@ -40 +41 @@\n-x\n+y";
  const review = {
    repo: "acme/widgets",
    number: 8,
    sha: "abc123",
    summary: "",
    comments: [
      { path: "src/a.ts", start: 8, end: 12, title: "Spans the hunk's start", body: "B." },
      { path: "src/a.ts", start: 20, end: 30, title: "Between hunks", body: "C.", unverified: true as const },
      { path: "src/a.ts", start: 12, end: 41, title: "Spans both hunks", body: "D.", unverified: true as const },
    ],
  };

  function pull(head: string) {
    return recorder(function respond(path, init) {
      if (path.includes("/reviews?per_page")) return [];
      if (path.includes("/pulls/8/comments?per_page")) {
        return [
          { id: 32, pull_request_review_id: 9, path: "src/a.ts", original_start_line: 12, original_line: 13, body: "**Spans both hunks**\n\nD.\n\nAlso lines 14–41.\n\n_Not checked against the file._" },
          { id: 31, pull_request_review_id: 9, path: "src/a.ts", original_start_line: 10, original_line: 12, body: "**Spans the hunk's start**\n\nB.\n\nAlso lines 8–9." },
        ];
      }
      if (path.includes("/files?per_page")) return [{ filename: "src/a.ts", status: "modified", patch: PATCH }];
      if (path.endsWith("/pulls/8") && !init?.method) return { state: "open", head: { sha: head }, base: { repo: { id: 1 } } };
      return { id: 9 };
    });
  }

  test("anchors a range to the first hunk that shows it, names the lines past it, keeps lines between hunks in the body, marks unverified findings, and names each inline finding's comment", async () => {
    const { gh, requests } = pull("abc123");
    expect(await sendCodeReview(gh, review, login)).toEqual({ reviewId: 9, sent: true, threads: [31, null, 32] });
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      commit_id: "abc123",
      event: "COMMENT",
      body: "**Between hunks** · `src/a.ts:20–30`\n\nC.\n\n_Not checked against the file._\n\n<!-- corbits-code-review -->",
      comments: [
        { path: "src/a.ts", start_line: 10, start_side: "RIGHT", line: 12, side: "RIGHT", body: "**Spans the hunk's start**\n\nB.\n\nAlso lines 8–9." },
        { path: "src/a.ts", start_line: 12, start_side: "RIGHT", line: 13, side: "RIGHT", body: "**Spans both hunks**\n\nD.\n\nAlso lines 14–41.\n\n_Not checked against the file._" },
      ],
    });
  });

  test("lists as many findings outside the diff as fit GitHub's body limit, then how many more the portal holds", async () => {
    const { gh, requests } = pull("abc123");
    const long = Array.from({ length: 5 }, (_, index) => ({ path: "src/b.ts", start: index + 1, end: index + 1, title: `T${index}`, body: "x".repeat(20_000) }));
    await sendCodeReview(gh, { ...review, comments: long }, login);
    const body = (requests.find((request) => request.method === "POST")!.body as { body: string }).body;
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.match(/\*\*T\d\*\*/g)).toEqual(["**T0**", "**T1**", "**T2**"]);
    expect(body.endsWith("2 more in the portal.\n\n<!-- corbits-code-review -->")).toBe(true);
  });

  /** The App's reviews as GitHub keeps them, the pull request's inline comments listed back newest first, on a pull request whose head can move. */
  function reviewedPull() {
    const reviews: Array<{ id: number; user: typeof APP; commit_id: string; body: string; comments: Array<{ path: string; body: string; line: number; start_line?: number }> }> = [];
    const pr = { head: "abc123", patch: PATCH, readBack: true, dropFirst: false };
    const { gh, requests } = recorder(function respond(path, init) {
      if (path.includes("/reviews?per_page")) return reviews;
      if (path.includes("/files?per_page")) return [{ filename: "src/a.ts", status: "modified", patch: pr.patch }];
      if (path.endsWith("/pulls/8") && !init?.method) return { state: "open", head: { sha: pr.head }, base: { repo: { id: 1 } } };
      const listed = path.includes("/pulls/8/comments?per_page");
      if (listed && !pr.readBack) return Response.json({ message: "Server Error" }, { status: 502 });
      if (listed) {
        const rows = reviews.flatMap((posted) => posted.comments.map(({ path: file, body, line, start_line }, index) => ({ id: 40 + index, pull_request_review_id: posted.id, path: file, body, original_line: line, original_start_line: start_line ?? null })));
        return rows.slice(pr.dropFirst ? 1 : 0).reverse();
      }
      const posted = JSON.parse(String(init?.body));
      reviews.push({ id: 9, user: APP, commit_id: posted.commit_id, body: posted.body, comments: posted.comments });
      return { id: 9 };
    });
    return { gh, requests, pr };
  }

  test("a review sent again writes nothing and names the same comment for each finding", async () => {
    const { gh, requests } = reviewedPull();
    const first = await sendCodeReview(gh, review, login);
    const again = await sendCodeReview(gh, review, login);
    expect(first).toEqual({ reviewId: 9, sent: true, threads: [40, null, 41] });
    expect(again).toEqual({ reviewId: 9, sent: false, threads: first.threads });
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("a review sent again from a newer head whose diff moved finds its comments by the lines they were written on", async () => {
    const { gh, pr } = reviewedPull();
    await sendCodeReview(gh, review, login);
    pr.head = "def456";
    pr.patch = "@@ -10,3 +12,4 @@\n ten\n-old\n+new\n+added\n twelve\n@@ -40 +43 @@\n-x\n+y";
    expect(await sendCodeReview(gh, { ...review, sha: "def456", reviewed: "abc123" }, login)).toEqual({ reviewId: 9, sent: false, threads: [40, null, 41] });
  });

  test("findings of the same text on different lines each get their own comment", async () => {
    const { gh } = reviewedPull();
    const twin = { path: "src/a.ts", title: "Unchecked input", body: "Validate it first." };
    expect(await sendCodeReview(gh, { ...review, comments: [{ ...twin, start: 11, end: 11 }, { ...twin, start: 41, end: 41 }] }, login)).toEqual({ reviewId: 9, sent: true, threads: [40, 41] });
  });

  test("a posted inline comment missing from the read-back leaves the review's comments unread rather than passing it for a summary finding", async () => {
    const { gh, pr } = reviewedPull();
    pr.dropFirst = true;
    expect(await sendCodeReview(gh, review, login)).toEqual({ reviewId: 9, sent: true, threads: null, unread: "1 of review 9's 2 inline comments matched no finding" });
  });

  test("a posted review whose comments cannot be read back still counts as sent, with its comments unknown until it is sent again", async () => {
    const { gh, pr } = reviewedPull();
    pr.readBack = false;
    expect(await sendCodeReview(gh, review, login)).toEqual({ reviewId: 9, sent: true, threads: null, unread: expect.stringContaining("502") });
    pr.readBack = true;
    expect(await sendCodeReview(gh, review, login)).toEqual({ reviewId: 9, sent: false, threads: [40, null, 41] });
  });

  test("writes nothing once the pull request has moved past the reviewed head", async () => {
    const { gh, requests } = pull("def456");
    expect(await sendCodeReview(gh, review, login)).toMatchObject({ reviewId: null, sent: false });
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });
});

describe("findingThreadStates", () => {
  test("reads a reply from a long thread's newest comments, and Triage's own later comments are no reply", async () => {
    function comment(databaseId: number, login: string) {
      return { databaseId, createdAt: `2026-10-20T00:00:${String(databaseId % 60).padStart(2, "0")}Z`, author: { login } };
    }
    const opener = comment(501, APP.login);
    const newest = [...Array.from({ length: 99 }, (_, index) => comment(1000 + index, APP.login)), comment(1099, "octocat")];
    const threads = [
      { isResolved: false, isOutdated: false, opener: { nodes: [opener] }, comments: { nodes: newest } },
      { isResolved: false, isOutdated: false, opener: { nodes: [comment(502, APP.login)] }, comments: { nodes: [comment(502, APP.login), comment(503, APP.login)] } },
    ];
    const { gh, requests } = recorder(function respond() {
      return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads } } } } };
    });
    expect(await findingThreadStates(gh, "acme/widgets", 8, [501, 502])).toEqual([
      { id: 501, state: "replied", at: comment(1099, "octocat").createdAt },
      { id: 502, state: "untouched" },
    ]);
    expect((requests[0]!.body as { query: string }).query).toContain("comments(last: 100)");
  });
});
