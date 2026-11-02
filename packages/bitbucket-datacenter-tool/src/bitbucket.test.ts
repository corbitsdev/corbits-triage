import { describe, expect, test } from "bun:test";
import { executeAction, type ActionStep } from "./action";
import { findingThreadStates, mirror, sendCodeReview, type BitbucketFetch, type Comment } from "./bitbucket";
import { runAction } from "./sidecar-bundle";

const BOT = { id: 7, slug: "triage-bot" };
const AUTHOR = { id: 3, slug: "admin" };
const REPO_PATH = "/rest/api/1.0/projects/TRI/repos/widgets";
const PR_PATH = `${REPO_PATH}/pull-requests/1`;

// Shapes recorded from Bitbucket Data Center 10.5, trimmed to the fields read.
function fakeBitbucket(seed: { comments?: Comment[]; builds?: string[]; merge?: unknown; failPost?: number; failBuild?: boolean; failStatus?: boolean; failDelete?: boolean; participants?: unknown[]; openReads?: number; threads?: unknown[] | "refused" } = {}) {
  const pr = { id: 1, version: 4, state: "OPEN", fromRef: { id: "refs/heads/fix", latestCommit: "abc", repository: { id: 1 } }, toRef: { repository: { id: 1 } }, links: { self: [{ href: "https://bitbucket.example/projects/TRI/repos/widgets/pull-requests/1" }] }, author: { user: AUTHOR }, reviewers: [] as unknown[], participants: seed.participants ?? [] };
  const comments: Comment[] = seed.comments ?? [];
  let nextCommentId = comments.length + 10;
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
      comments.push({ id: nextCommentId++, version: 0, text: body.text, author: BOT, updatedDate: 1_791_999_000_000 });
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
    if (method === "PUT" && path === `${PR_PATH}/participants/triage-bot`) {
      if (seed.failStatus) return Response.json({ errors: [{ message: "unavailable" }] }, { status: 503 });
      return Response.json({ status: body.status });
    }
    if (method === "GET" && path === `${PR_PATH}/merge`) return Response.json(seed.merge ?? { canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] });
    if (method === "POST" && path === `${PR_PATH}/merge?version=4`) return Response.json({ ...pr, state: "MERGED" });
    if (method === "POST" && path === `${PR_PATH}/decline?version=4`) return Response.json({ ...pr, state: "DECLINED" });
    if (method === "DELETE" && path.startsWith(`${PR_PATH}/comments/`)) {
      if (seed.failDelete) return Response.json({ errors: [{ message: "unavailable" }] }, { status: 503 });
      const id = Number(path.slice(`${PR_PATH}/comments/`.length).split("?")[0]);
      const index = comments.findIndex((comment) => comment.id === id);
      if (index >= 0) comments.splice(index, 1);
      return new Response(null, { status: 204 });
    }
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
    expect(fake.comments.find((c) => c.id === 11)!.text).toBe(`[corbits-triage]: #${encodeURIComponent(JSON.stringify({ ...HEADER, shows: "verdict" }))}\nStill pass`);
    expect(fake.comments.find((c) => c.id === 2)!.text).toBe("[corbits-triage]: #copied\nNot ours");
  });

  test("progress over CI progress written over a verdict writes, though the verdict and policy are the same", async () => {
    const fake = fakeBitbucket();
    await mirror(fake.bb, { ...REQUEST, header: HEADER }, user);
    await mirror(fake.bb, { ...REQUEST, comment: "In progress: CI", onHead: "abc" }, user);
    expect(await mirror(fake.bb, { ...REQUEST, comment: "In progress: code review", onHead: "abc", keepVerdict: { verdict: "pass", policy: null } }, user)).toMatchObject({ commentId: 10, updated: true });
    expect(fake.comments[0]!.text).toEndWith("\nIn progress: code review");
  });

  test.each([
    ["a comment from before the marker said what it shows is read as its verdict and kept", {}, true],
    ["a comment that shows progress is written over", { shows: "progress" }, false],
    ["a comment that shows its verdict is kept", { shows: "verdict" }, true],
  ])("matching progress: %s", async (_name, shows, kept) => {
    const text = `[corbits-triage]: #${encodeURIComponent(JSON.stringify({ ...HEADER, ...shows }))}\nPass`;
    const fake = fakeBitbucket({ comments: [{ id: 12, version: 0, text, author: BOT }] });
    await mirror(fake.bb, { ...REQUEST, comment: "In progress", onHead: "abc", keepVerdict: { verdict: "pass", policy: null } }, user);
    expect(fake.comments[0]!.text === text).toBe(kept);
  });

  test("progress over a verdict made under another policy writes, though the verdict is the same", async () => {
    const fake = fakeBitbucket();
    await mirror(fake.bb, { ...REQUEST, header: HEADER }, user);
    const keepVerdict = { verdict: "pass", policy: { repo: { id: "art_policy", version: 2 } } };
    expect(await mirror(fake.bb, { ...REQUEST, comment: "In progress", onHead: "abc", keepVerdict }, user)).toMatchObject({ commentId: 10, updated: true });
    expect(fake.comments[0]!.text).toEndWith("\nIn progress");
  });

  test("progress keeps a verdict on the head only while it is the pass's verdict", async () => {
    const fake = fakeBitbucket();
    await mirror(fake.bb, { ...REQUEST, header: HEADER }, user);
    const progress = { ...REQUEST, comment: "In progress", onHead: "abc" };
    expect(await mirror(fake.bb, { ...progress, keepVerdict: { verdict: "pass", policy: null } }, user)).toMatchObject({ commentId: 10, updated: false, kept: "verdict" });
    expect(fake.comments[0]!.text).toEndWith("\nPass");
    expect(await mirror(fake.bb, { ...progress, keepVerdict: { verdict: "fail", policy: null } }, user)).toMatchObject({ commentId: 10, updated: true });
    expect(fake.comments[0]!.text).toEndWith("\nIn progress");
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

  test("refuses a merge while a person's inline thread is neither resolved nor orphaned, or the threads cannot be read; triage's own findings are left to code review", async () => {
    function thread(id: number, slug: string, fields: object) {
      return { id, text: "note", author: { slug }, createdDate: 0, ...fields };
    }
    const threads = [
      thread(1, "maya", { anchor: { orphaned: false }, threadResolved: false, comments: [thread(5, "admin", {})] }),
      thread(2, "li", { anchor: { orphaned: false }, threadResolved: true }),
      thread(3, "li", { anchor: { orphaned: true }, threadResolved: false }),
      thread(4, "triage-bot", { threadResolved: false }),
      { ...thread(6, "triage-bot", { anchor: { orphaned: false }, threadResolved: false }), text: "[corbits-code-review]: #abc/0123456789ab\n**P1 · Off by one**" },
    ];
    const findingOnly = fakeBitbucket({ threads: threads.slice(-1) });
    expect(await executeAction(findingOnly.bb, { request: REQUEST, step: step("merge", {}) }, user)).toEqual({ status: "done", result: { merged: true } });
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

describe("executeAction request-changes", () => {
  const verdict = { id: 2, version: 1, text: "[corbits-triage]: #abc\nFail", author: BOT };
  const action = { id: 3, version: 0, text: "[corbits-action]: #other\nLeave this", author: BOT };
  const copied = { id: 4, version: 0, text: "[corbits-triage]: #copied\nNot ours", author: AUTHOR };
  const task = { request: REQUEST, step: step("request-changes", { body: "Fix the checks" }) };

  test("drops the verdict comment only after the comment is posted and needs-work is set", async () => {
    const fake = fakeBitbucket({ comments: [{ ...verdict }, { ...action }, { ...copied }] });
    expect((await executeAction(fake.bb, task, user)).status).toBe("done");
    expect(fake.comments.map((comment) => comment.id)).toEqual([3, 4, 13]);
    expect(fake.comments.find((comment) => comment.id === 13)!.text).toBe("[corbits-action]: #e1\nFix the checks");
    expect(fake.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      `POST ${PR_PATH}/comments`,
      `PUT ${PR_PATH}/participants/triage-bot`,
      `DELETE ${PR_PATH}/comments/2?version=1`,
    ]);
  });

  test("a comment Bitbucket refuses leaves the verdict comment", async () => {
    const fake = fakeBitbucket({ comments: [{ ...verdict }], failPost: 1 });
    await expect(executeAction(fake.bb, task, user)).rejects.toThrow("503");
    expect(fake.comments.map((comment) => comment.id)).toEqual([2]);
    expect(fake.writes.map((write) => write.method)).toEqual(["POST"]);
  });

  test("needs-work Bitbucket refuses leaves the verdict comment", async () => {
    const fake = fakeBitbucket({ comments: [{ ...verdict }], failStatus: true });
    await expect(executeAction(fake.bb, task, user)).rejects.toThrow("503");
    expect(fake.comments.map((comment) => comment.id)).toEqual([2, 11]);
    expect(fake.writes.map((write) => write.method)).toEqual(["POST", "PUT"]);
  });

  test("needs-work already set on this head deletes the verdict comment and does not post another", async () => {
    const reasons = { ...action, text: "[corbits-action]: #e1\nFix the checks" };
    const standing = fakeBitbucket({ comments: [{ ...verdict }, reasons, { ...copied }], participants: [{ user: BOT, status: "NEEDS_WORK", lastReviewedCommit: "abc" }] });
    expect(await executeAction(standing.bb, task, user)).toEqual({ status: "satisfied", result: { status: "NEEDS_WORK" } });
    expect(standing.comments.map((comment) => comment.id)).toEqual([3, 4]);
    expect(standing.writes.map((write) => `${write.method} ${write.path}`)).toEqual([`DELETE ${PR_PATH}/comments/2?version=1`]);
  });

  test("needs-work set by hand posts this action's comment before deleting the verdict", async () => {
    const hand = fakeBitbucket({ comments: [{ ...verdict }, { ...action }, { ...copied }], participants: [{ user: BOT, status: "NEEDS_WORK", lastReviewedCommit: "abc" }] });
    expect(await executeAction(hand.bb, task, user)).toEqual({ status: "done", result: { commentId: 13, status: "NEEDS_WORK" } });
    expect(hand.comments.map((comment) => comment.id)).toEqual([3, 4, 13]);
    expect(hand.comments.find((comment) => comment.id === 13)!.text).toBe("[corbits-action]: #e1\nFix the checks");
    expect(hand.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      `POST ${PR_PATH}/comments`,
      `DELETE ${PR_PATH}/comments/2?version=1`,
    ]);
  });

  test("a comment refused while needs-work is already on this head leaves the verdict comment", async () => {
    const hand = fakeBitbucket({ comments: [{ ...verdict }], failPost: 1, participants: [{ user: BOT, status: "NEEDS_WORK", lastReviewedCommit: "abc" }] });
    await expect(executeAction(hand.bb, task, user)).rejects.toThrow("503");
    expect(hand.comments.map((comment) => comment.id)).toEqual([2]);
    expect(hand.writes.map((write) => write.method)).toEqual(["POST"]);
  });

  test("a verdict delete Bitbucket refuses still counts the posted needs-work as done", async () => {
    const fake = fakeBitbucket({ comments: [{ ...verdict }], failDelete: true });
    expect(await executeAction(fake.bb, task, user)).toMatchObject({ status: "done", result: { commentId: 11, status: "NEEDS_WORK" } });
    expect(fake.comments.map((comment) => comment.id)).toEqual([2, 11]);
    expect(fake.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      `POST ${PR_PATH}/comments`,
      `PUT ${PR_PATH}/participants/triage-bot`,
      `DELETE ${PR_PATH}/comments/2?version=1`,
    ]);
  });

  test("needs-work from an older head still posts this head's comment, then drops the verdict", async () => {
    const older = fakeBitbucket({ comments: [{ ...verdict }], participants: [{ user: BOT, status: "NEEDS_WORK", lastReviewedCommit: "old" }] });
    expect((await executeAction(older.bb, task, user)).status).toBe("done");
    expect(older.comments.map((comment) => comment.id)).toEqual([11]);
    expect(older.comments[0]!.text).toBe("[corbits-action]: #e1\nFix the checks");
    expect(older.writes.map((write) => `${write.method} ${write.path}`)).toEqual([
      `POST ${PR_PATH}/comments`,
      `PUT ${PR_PATH}/participants/triage-bot`,
      `DELETE ${PR_PATH}/comments/2?version=1`,
    ]);
  });

  test("a comment refused while an older needs-work stands leaves the verdict comment", async () => {
    const older = fakeBitbucket({ comments: [{ ...verdict }], failPost: 1, participants: [{ user: BOT, status: "NEEDS_WORK", lastReviewedCommit: "old" }] });
    await expect(executeAction(older.bb, task, user)).rejects.toThrow("503");
    expect(older.comments.map((comment) => comment.id)).toEqual([2]);
    expect(older.writes.map((write) => write.method)).toEqual(["POST"]);
  });

  test("a request-changes write skipped because the head moved leaves the verdict comment", async () => {
    const moved = fakeBitbucket({ comments: [{ ...verdict }] });
    const stepMoved = { request: REQUEST, step: { ...task.step, headSha: "old" } };
    await expect(executeAction(moved.bb, stepMoved, user)).rejects.toThrow("new commits");
    expect(moved.comments.map((comment) => comment.id)).toEqual([2]);
    expect(moved.writes).toEqual([]);
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
        text: expect.stringMatching(/^\[corbits-code-review\]: #abc\/[0-9a-f]{12}\n\*\*P1 · Off by one\*\*\n\nThe loop stops early\.\n\nAlso lines 12–14\.\n\nResolve this comment\. Triage will not finish while it is open\.$/),
        anchor: { path: "src/app.ts", line: 11, lineType: "ADDED", fileType: "TO", diffType: "EFFECTIVE", fromHash: "base", toHash: "abc" },
      },
      { text: "[corbits-code-review]: #abc\nTwo findings.\n\n**Unused import** · `src/app.ts:40`\n\nRemove it.\n\nResolve this comment. Triage will not finish while it is open." },
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
