import { describe, expect, test } from "bun:test";
import { executeAction, type ActionStep } from "./action";
import { findingThreadStates, mirror, sendCodeReview, type BitbucketFetch, type Comment } from "./bitbucket";
import { runAction } from "./sidecar-bundle";

const BOT = { id: 7, slug: "triage-bot" };
const AUTHOR = { id: 3, slug: "admin" };
const REPO_PATH = "/rest/api/1.0/projects/TRI/repos/widgets";
const PR_PATH = `${REPO_PATH}/pull-requests/1`;

// Shapes recorded from Bitbucket Data Center 10.5, trimmed to the fields read.
function fakeBitbucket(seed: { comments?: Comment[]; builds?: string[]; merge?: unknown; failPost?: number; failBuild?: boolean; participants?: unknown[]; openReads?: number; threads?: unknown[] | "refused" } = {}) {
  const pr = { id: 1, version: 4, state: "OPEN", fromRef: { id: "refs/heads/fix", latestCommit: "abc", repository: { id: 1 } }, toRef: { repository: { id: 1 } }, links: { self: [{ href: "https://bitbucket.example/projects/TRI/repos/widgets/pull-requests/1" }] }, author: { user: AUTHOR }, reviewers: [] as unknown[], participants: seed.participants ?? [] };
  const comments: Comment[] = seed.comments ?? [];
  const builds: Array<Record<string, unknown>> = [];
  const writes: Array<{ method: string; path: string; body: any }> = [];
  const requested: string[] = [];
  async function bb(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    requested.push(path);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/rest/api/1.0/application-properties") return Response.json({ version: "10.5.1" }, { headers: { "x-auserid": "7", "x-ausername": "triage-bot" } });
    if (path.startsWith("/rest/api/1.0/users?")) return Response.json({ values: [BOT], isLastPage: true });
    if (path === PR_PATH) return Response.json(requested.filter((p) => p === PR_PATH).length > (seed.openReads ?? Infinity) ? { ...pr, state: "DECLINED" } : pr);
    if (path === `${REPO_PATH}/commits/abc`) return Response.json({ id: "abc" });
    if (path.startsWith(`${REPO_PATH}/commits?since=abc&until=d36740c&`)) return Response.json({ values: ["merge1521", "d36740c"].map((id) => ({ id, message: id, author: { name: "admin" }, committerTimestamp: 0 })), isLastPage: true });
    if (path.startsWith(`${REPO_PATH}/pull-requests?state=MERGED&direction=INCOMING&at=refs%2Fheads%2Ffix&`)) return Response.json({ values: [{ id: 1521, properties: { mergeCommit: { id: "merge1521" } } }, { id: 1490, properties: { mergeCommit: { id: "elsewhere" } } }], isLastPage: true });
    if (path.startsWith(`${PR_PATH}/activities?`)) {
      if (seed.threads === "refused") return Response.json({ errors: [{ message: "unavailable" }] }, { status: 503 });
      if (seed.threads) return Response.json({ values: seed.threads.map((comment) => ({ action: "COMMENTED", commentAction: "ADDED", comment })), isLastPage: true });
      const values = comments.map((comment) => ({ action: "COMMENTED", commentAction: "ADDED", comment })).reverse();
      return Response.json({ values: [{ action: "OPENED" }, ...values], isLastPage: true });
    }
    if (path === `${PR_PATH}/diff/src/app.ts?withComments=false`) return Response.json(APP_DIFF);
    if (path === `${PR_PATH}/diff/src/untouched.ts?withComments=false`) return Response.json({ fromHash: "base", toHash: "abc", diffs: [] });
    if (method === "POST" && path === `${PR_PATH}/comments`) {
      if (writes.filter((w) => w.path === path).length === seed.failPost) return Response.json({ errors: [{ message: "unavailable" }] }, { status: 503 });
      comments.push({ id: comments.length + 10, version: 0, text: body.text, author: BOT, updatedDate: 1_791_999_000_000 });
      return Response.json(comments.at(-1));
    }
    const edited = comments.find((c) => method === "PUT" && path === `${PR_PATH}/comments/${c.id}`);
    if (edited) {
      if (body.version !== edited.version) return Response.json({ errors: [{ message: "stale version" }] }, { status: 409 });
      Object.assign(edited, { text: body.text, version: edited.version + 1 });
      return Response.json(edited);
    }
    if (path.startsWith("/rest/build-status/1.0/commits/abc?")) return Response.json({ values: [...builds, ...(seed.builds ?? ["SUCCESSFUL"]).map((state) => ({ state, key: state.toLowerCase() }))], isLastPage: true });
    if (method === "POST" && seed.failBuild && path.startsWith("/rest/build-status/1.0/commits/")) return Response.json({ errors: [{ message: "unavailable" }] }, { status: 503 });
    if (method === "POST" && path === "/rest/build-status/1.0/commits/abc") {
      builds.splice(0, builds.length, body);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/rest/build-status/1.0/commits/old?")) return Response.json({ values: [], isLastPage: true });
    if (method === "POST" && path === "/rest/build-status/1.0/commits/old") return new Response(null, { status: 204 });
    if (method === "PUT" && path === `${PR_PATH}/participants/triage-bot`) return Response.json({ status: body.status });
    if (method === "GET" && path === `${PR_PATH}/merge`) return Response.json(seed.merge ?? { canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] });
    if (method === "POST" && path === `${PR_PATH}/merge?version=4`) return Response.json({ ...pr, state: "MERGED" });
    if (method === "POST" && path === `${PR_PATH}/decline?version=4`) return Response.json({ ...pr, state: "DECLINED" });
    throw new Error(`unexpected ${method} ${path}`);
  }
  return { bb: bb satisfies BitbucketFetch, comments, builds, writes, requested };
}

// Lines 10-12 changed: 10 is context, 11-12 added.
const APP_DIFF = {
  fromHash: "base",
  toHash: "abc",
  diffs: [{ hunks: [{ segments: [
    { type: "CONTEXT", lines: [{ source: 10, destination: 10 }] },
    { type: "REMOVED", lines: [{ source: 11, destination: 11 }] },
    { type: "ADDED", lines: [{ source: 12, destination: 11 }, { source: 12, destination: 12 }] },
  ] }] }],
};

const REQUEST = { repo: "TRI/widgets", number: 1, labels: ["triage:pass"], owned: ["triage:pass"], comment: "Pass" };
const HEADER = { head: "abc", policy: null, verdict: "pass" };

function user() {
  return Promise.resolve(BOT);
}

function step(kind: ActionStep["kind"], target: ActionStep["target"]): ActionStep {
  return { effectId: "e1", headSha: "abc", kind, target };
}

describe("mirror", () => {
  test("creates the Triage comment, edits it in place with its version, then leaves it alone", async () => {
    const fake = fakeBitbucket({ comments: [{ id: 2, version: 0, text: "[corbits-triage]: #copied\nNot ours", author: AUTHOR }] });
    const first = await mirror(fake.bb, { ...REQUEST, header: HEADER }, user);
    const second = await mirror(fake.bb, { ...REQUEST, comment: "Still pass", header: HEADER }, user);
    const third = await mirror(fake.bb, { ...REQUEST, comment: "Still pass", header: HEADER }, user);
    expect(first).toMatchObject({ commentId: 11, updated: false });
    expect(second).toMatchObject({ commentId: 11, updated: true });
    expect(third).toMatchObject({ commentId: 11, updated: false, unchanged: expect.stringContaining("unchanged since") });
    expect(fake.comments.find((c) => c.id === 11)!.text).toBe(`[corbits-triage]: #${encodeURIComponent(JSON.stringify(HEADER))}\nStill pass`);
    expect(fake.comments.find((c) => c.id === 2)!.text).toBe("[corbits-triage]: #copied\nNot ours");
  });

  test("a verdict that changes on a new head says what reached the branch since, in the same comment, and keeps saying it on a rerun", async () => {
    const fake = fakeBitbucket();
    await mirror(fake.bb, { ...REQUEST, header: HEADER }, user);
    const failed = { ...REQUEST, comment: "Fail", header: { head: "d36740c", policy: null, verdict: "fail" } };
    await mirror(fake.bb, failed, user);
    await mirror(fake.bb, failed, user);
    expect(fake.comments).toHaveLength(1);
    expect(fake.comments[0]!.text).toEndWith("\nFail\n\nChanged since the last verdict (Pass at `abc`): 2 new commits, merging #1521 into this branch.");
  });
});

describe("mirror build status", () => {
  const PR_URL = "https://bitbucket.example/projects/TRI/repos/widgets/pull-requests/1";

  test("writes the verdict build status on the head once, linking to the verdict comment", async () => {
    const fake = fakeBitbucket();
    const status = { state: "failure" as const, description: "Fail: rule: ci-green" };
    expect(await mirror(fake.bb, { ...REQUEST, comment: "Fail", header: HEADER, status, statusHead: "abc" }, user)).toMatchObject({ commentId: 10, build: "FAILED", buildWritten: true });
    expect(await mirror(fake.bb, { ...REQUEST, comment: "Fail", header: HEADER, status, statusHead: "abc" }, user)).toMatchObject({ build: "FAILED", buildWritten: false });
    expect(fake.builds).toEqual([{ state: "FAILED", key: "corbits-triage", name: "Corbits Triage", url: `${PR_URL}/overview?commentId=10`, description: "Fail: rule: ci-green" }]);
  });

  test("without a comment it links to the pull request page", async () => {
    const fake = fakeBitbucket();
    const { comment: _comment, ...uncommented } = REQUEST;
    expect(await mirror(fake.bb, { ...uncommented, status: { state: "pending", description: "Needs review" }, statusHead: "abc" }, user)).toMatchObject({ commentId: null, build: "INPROGRESS", buildWritten: true });
    expect(fake.builds).toEqual([{ state: "INPROGRESS", key: "corbits-triage", name: "Corbits Triage", url: PR_URL, description: "Needs review" }]);
    expect(fake.writes.map((w) => w.path)).toEqual(["/rest/build-status/1.0/commits/abc"]);
  });

  test("a verdict on an older head writes its status on that head, never on the head the pull request has now", async () => {
    const fake = fakeBitbucket();
    const { comment: _comment, ...uncommented } = REQUEST;
    await mirror(fake.bb, { ...uncommented, status: { state: "success", description: "Pass" }, statusHead: "old" }, user);
    expect(fake.writes.map((w) => w.path)).toEqual(["/rest/build-status/1.0/commits/old"]);
    expect(fake.builds).toEqual([]);
  });

  test("a status Bitbucket refuses is named in the result, and the comment and the take-back still go through", async () => {
    const fake = fakeBitbucket({ failBuild: true, participants: [{ user: BOT, role: "REVIEWER", status: "APPROVED" }] });
    const result = await mirror(fake.bb, { ...REQUEST, header: HEADER, status: { state: "failure", description: "Fail" }, statusHead: "abc", notReadyHead: "abc" }, user);
    expect(result).toMatchObject({ commentId: 10, dismissed: ["APPROVED"], failed: { status: expect.stringContaining("503") } });
    expect(fake.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST ${PR_PATH}/comments`, "POST /rest/build-status/1.0/commits/abc", `PUT ${PR_PATH}/participants/triage-bot`]);
  });
});

describe("executeAction", () => {
  test("posts a comment once under its effect id", async () => {
    const fake = fakeBitbucket();
    const input = { request: REQUEST, step: step("comment", { body: "Hello" }) };
    expect((await executeAction(fake.bb, input, user)).status).toBe("done");
    expect((await executeAction(fake.bb, input, user)).status).toBe("satisfied");
    expect(fake.writes).toHaveLength(1);
  });

  test("refuses a merge with Bitbucket's veto, and merges the read version once checks pass", async () => {
    const vetoed = fakeBitbucket({ merge: { canMerge: false, conflicted: false, vetoes: [{ summaryMessage: "Not enough approvals", detailedMessage: "Requires 1 approval" }] } });
    expect(await runAction(vetoed.bb, { request: REQUEST, step: step("merge", {}) }, user)).toEqual({ status: "skipped", reason: "Requires 1 approval" });
    const failing = fakeBitbucket({ builds: ["FAILED", "SUCCESSFUL"] });
    expect(await runAction(failing.bb, { request: REQUEST, step: step("merge", {}) }, user)).toEqual({ status: "skipped", reason: "CI has failed on this head" });
    const clean = fakeBitbucket();
    expect(await executeAction(clean.bb, { request: REQUEST, step: step("merge", {}) }, user)).toEqual({ status: "done", result: { merged: true } });
    expect(clean.writes.map((w) => w.path)).toEqual([`${PR_PATH}/merge?version=4`]);
  });

  test("refuses a merge while an inline thread is neither resolved nor orphaned, or the threads cannot be read", async () => {
    function thread(id: number, slug: string, fields: object) {
      return { id, text: "note", author: { slug }, createdDate: 0, ...fields };
    }
    const threads = [
      thread(1, "maya", { anchor: { orphaned: false }, threadResolved: false, comments: [thread(5, "admin", {})] }),
      thread(2, "li", { anchor: { orphaned: false }, threadResolved: true }),
      thread(3, "li", { anchor: { orphaned: true }, threadResolved: false }),
      thread(4, "triage-bot", { threadResolved: false }),
    ];
    const open = fakeBitbucket({ threads });
    expect(await runAction(open.bb, { request: REQUEST, step: step("merge", {}) }, user)).toEqual({ status: "skipped", reason: "Merge waits for 1 unresolved review thread, opened by maya." });
    const refused = fakeBitbucket({ threads: "refused" });
    expect(await runAction(refused.bb, { request: REQUEST, step: step("merge", {}) }, user)).toMatchObject({ status: "skipped", reason: expect.stringContaining("Merge waits: Triage couldn't read the review threads") });
    expect([...open.writes, ...refused.writes]).toEqual([]);
  });
});

describe("executeAction close", () => {
  const CLOSE = { request: REQUEST, step: step("close", {}) };

  test("posts the verdict's comment, then declines", async () => {
    const fake = fakeBitbucket();
    expect(await executeAction(fake.bb, CLOSE, user)).toMatchObject({ status: "done", result: { commentId: 10, closed: true } });
    expect(fake.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST ${PR_PATH}/comments`, `POST ${PR_PATH}/decline?version=4`]);
  });

  test("a pull request closed between the reads is satisfied, with nothing written", async () => {
    const fake = fakeBitbucket({ openReads: 1 });
    expect(await executeAction(fake.bb, CLOSE, user)).toEqual({ status: "satisfied", result: { closed: true } });
    expect(fake.writes).toEqual([]);
  });

  test("a comment Bitbucket refuses fails the close, which declines nothing", async () => {
    const fake = fakeBitbucket({ failPost: 1 });
    await expect(executeAction(fake.bb, CLOSE, user)).rejects.toThrow("503");
    expect(fake.writes.map((w) => `${w.method} ${w.path}`)).toEqual([`POST ${PR_PATH}/comments`]);
  });
});

describe("sendCodeReview", () => {
  const FINDINGS = [
    { path: "src/app.ts", start: 11, end: 14, title: "Off by one", body: "The loop stops early.", priority: 1 },
    { path: "src/app.ts", start: 40, end: 40, title: "Unused import", body: "Remove it." },
  ];
  const REVIEW = { repo: "TRI/widgets", number: 1, sha: "abc", summary: "Two findings.", comments: FINDINGS };
  const MARKER = /^\[corbits-code-review\]: #abc\/[0-9a-f]{12}$/;

  function firstLines(fake: ReturnType<typeof fakeBitbucket>): string[] {
    return fake.comments.map((c) => c.text.split("\n", 1)[0]!);
  }

  test("posts a finding the diff shows inline on its first shown line, the rest in the summary, once per head", async () => {
    const fake = fakeBitbucket();
    expect(await sendCodeReview(fake.bb, REVIEW, user)).toEqual({ commentId: 11, sent: true, threads: [10, null] });
    expect(await sendCodeReview(fake.bb, REVIEW, user)).toEqual({ commentId: 11, sent: false, threads: [10, null] });
    expect(await sendCodeReview(fake.bb, { ...REVIEW, sha: "d36740c", reviewed: "abc" }, user)).toEqual({ commentId: 11, sent: false, threads: [10, null] });
    expect(fake.writes.map((w) => w.body)).toEqual([
      {
        text: expect.stringMatching(/^\[corbits-code-review\]: #abc\/[0-9a-f]{12}\n\*\*P1 · Off by one\*\*\n\nThe loop stops early\.\n\nAlso lines 12–14\.$/),
        anchor: { path: "src/app.ts", line: 11, lineType: "ADDED", fileType: "TO", diffType: "EFFECTIVE", fromHash: "base", toHash: "abc" },
      },
      { text: "[corbits-code-review]: #abc\nTwo findings.\n\n**Unused import** · `src/app.ts:40`\n\nRemove it." },
    ]);
  });

  test("writes nothing once the pull request has moved past the head", async () => {
    const fake = fakeBitbucket();
    expect(await sendCodeReview(fake.bb, { ...REVIEW, sha: "d36740c" }, user)).toMatchObject({ sent: false, skipped: expect.any(String) });
    expect(fake.writes).toEqual([]);
  });

  test("a send that failed part-way posts only what is missing", async () => {
    const fake = fakeBitbucket({ failPost: 2 });
    await expect(sendCodeReview(fake.bb, REVIEW, user)).rejects.toThrow("503");
    await sendCodeReview(fake.bb, REVIEW, user);
    const [inline, summary] = firstLines(fake);
    expect(inline).toMatch(MARKER);
    expect(summary).toBe("[corbits-code-review]: #abc");
    expect(fake.comments).toHaveLength(2);
  });

  test("a review made again on the same head after a part-way send posts its own findings", async () => {
    const fake = fakeBitbucket({ failPost: 2 });
    const first = { path: "src/app.ts", start: 11, end: 11, title: "Finding A", body: "a" };
    const second = { path: "src/app.ts", start: 12, end: 12, title: "Finding B", body: "b" };
    await expect(sendCodeReview(fake.bb, { ...REVIEW, summary: "S1", comments: [first] }, user)).rejects.toThrow("503");
    await sendCodeReview(fake.bb, { ...REVIEW, summary: "S2", comments: [second] }, user);
    expect(fake.comments.map((c) => c.text.split("\n")[1])).toEqual(["**Finding A**", "**Finding B**", "S2"]);
  });

  test("a finding on a line the diff does not show never posts inline", async () => {
    const fake = fakeBitbucket();
    const outside = [
      { path: "src/app.ts", start: 999, end: 999, title: "Past the end", body: "a" },
      { path: "src/app.ts", start: 1, end: 9, title: "Before the hunk", body: "b" },
      { path: "src/untouched.ts", start: 3, end: 3, title: "Not in the change", body: "c" },
    ];
    await sendCodeReview(fake.bb, { ...REVIEW, comments: outside }, user);
    expect(fake.writes.map((w) => w.body.anchor)).toEqual([undefined]);
    expect(fake.comments).toHaveLength(1);
  });

  test("a finding whose path leaves the repository root is never put in a request, only in the summary", async () => {
    const fake = fakeBitbucket();
    const escaping = { path: "../../../../admin/users", start: 1, end: 1, title: "Escapes", body: "a" };
    await sendCodeReview(fake.bb, { ...REVIEW, comments: [FINDINGS[0]!, escaping] }, user);
    expect(fake.requested.filter((path) => path.includes("/diff/"))).toEqual([`${PR_PATH}/diff/src/app.ts?withComments=false`]);
    expect(fake.comments.at(-1)!.text).toContain("**Escapes**");
  });
});

describe("findingThreadStates", () => {
  // A comment as Data Center answers it, trimmed to the fields read.
  const THREADS: Record<number, unknown> = {
    10: { id: 10, author: BOT, createdDate: 1, threadResolved: true, threadResolvedDate: 1_792_000_000_000, comments: [{ id: 20, author: AUTHOR, createdDate: 2 }] },
    11: { id: 11, author: BOT, createdDate: 1, threadResolved: false, anchor: { path: "src/app.ts", line: 11, orphaned: true } },
    12: { id: 12, author: BOT, createdDate: 1, comments: [{ id: 21, author: BOT, createdDate: 2, comments: [{ id: 22, author: AUTHOR, createdDate: 1_792_000_100_000 }] }] },
    13: { id: 13, author: BOT, createdDate: 1, threadResolved: false, comments: [{ id: 23, author: BOT, createdDate: 2 }] },
  };

  async function bb(path: string): Promise<Response> {
    const id = Number(path.slice(`${PR_PATH}/comments/`.length));
    if (id === 15) return Response.json({ errors: [{ message: "Server error" }] }, { status: 500 });
    return id in THREADS ? Response.json(THREADS[id]) : Response.json({ errors: [{ message: "No comment" }] }, { status: 404 });
  }

  test("reads a resolved, outdated, replied and untouched thread, a reply nested in Triage's own counting, leaves a deleted comment out, and names only a comment it failed to read as unread", async () => {
    expect(await findingThreadStates(bb, "TRI/widgets", 1, [10, 15, 11, 12, 13, 14])).toEqual({
      threads: [
        { id: 10, state: "resolved", at: new Date(1_792_000_000_000).toISOString() },
        { id: 11, state: "outdated" },
        { id: 12, state: "replied", at: new Date(1_792_000_100_000).toISOString() },
        { id: 13, state: "untouched" },
      ],
      unread: `bitbucket GET ${PR_PATH}/comments/15 -> 500 Server error`,
    });
  });
});
