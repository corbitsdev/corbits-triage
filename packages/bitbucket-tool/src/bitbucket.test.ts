import { describe, expect, test } from "bun:test";
import { executeAction, NO_LABELS, OWN_PULL_REQUEST, type ActionStep } from "./action";
import { mirror, type BitbucketFetch, type Comment } from "./bitbucket";
import { runAction } from "./sidecar-bundle";

const BOT = { id: 7, slug: "triage-bot" };
const AUTHOR = { id: 3, slug: "admin" };
const PR_PATH = "/rest/api/1.0/projects/TRI/repos/widgets/pull-requests/1";

// Shapes recorded from Bitbucket Data Center 10.5, trimmed to the fields read.
function fakeBitbucket(seed: { author?: typeof AUTHOR; comments?: Comment[]; builds?: string[]; merge?: unknown } = {}) {
  const pr = { id: 1, version: 4, state: "OPEN", fromRef: { latestCommit: "abc" }, author: { user: seed.author ?? AUTHOR }, reviewers: [] as unknown[], participants: [] as unknown[] };
  const comments: Comment[] = seed.comments ?? [];
  const writes: Array<{ method: string; path: string; body: any }> = [];
  async function bb(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "/rest/api/1.0/application-properties") return Response.json({ version: "10.5.1" }, { headers: { "x-auserid": "7", "x-ausername": "triage-bot" } });
    if (path.startsWith("/rest/api/1.0/users?")) return Response.json({ values: [BOT], isLastPage: true });
    if (path === PR_PATH) return Response.json(pr);
    if (path.startsWith(`${PR_PATH}/activities?`)) {
      const values = comments.map((comment) => ({ action: "COMMENTED", commentAction: "ADDED", comment })).reverse();
      return Response.json({ values: [{ action: "OPENED" }, ...values], isLastPage: true });
    }
    if (method === "POST" && path === `${PR_PATH}/comments`) {
      comments.push({ id: comments.length + 10, version: 0, text: body.text, author: BOT, updatedDate: 1_791_999_000_000 });
      return Response.json(comments.at(-1));
    }
    const edited = comments.find((c) => method === "PUT" && path === `${PR_PATH}/comments/${c.id}`);
    if (edited) {
      if (body.version !== edited.version) return Response.json({ errors: [{ message: "stale version" }] }, { status: 409 });
      Object.assign(edited, { text: body.text, version: edited.version + 1 });
      return Response.json(edited);
    }
    if (path.startsWith("/rest/build-status/1.0/commits/abc?")) return Response.json({ values: (seed.builds ?? ["SUCCESSFUL"]).map((state) => ({ state })), isLastPage: true });
    if (method === "GET" && path === `${PR_PATH}/merge`) return Response.json(seed.merge ?? { canMerge: true, conflicted: false, outcome: "CLEAN", vetoes: [] });
    if (method === "POST" && path === `${PR_PATH}/merge?version=4`) return Response.json({ ...pr, state: "MERGED" });
    throw new Error(`unexpected ${method} ${path}`);
  }
  return { bb: bb satisfies BitbucketFetch, comments, writes };
}

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
    const first = await mirror(fake.bb, { ...REQUEST, header: HEADER, close: false }, user);
    const second = await mirror(fake.bb, { ...REQUEST, comment: "Still pass", header: HEADER, close: false }, user);
    const third = await mirror(fake.bb, { ...REQUEST, comment: "Still pass", header: HEADER, close: false }, user);
    expect(first).toMatchObject({ commentId: 11, updated: false });
    expect(second).toMatchObject({ commentId: 11, updated: true });
    expect(third).toMatchObject({ commentId: 11, updated: false, unchanged: expect.stringContaining("unchanged since") });
    expect(fake.comments.find((c) => c.id === 11)!.text).toBe(`[corbits-triage]: #${encodeURIComponent(JSON.stringify(HEADER))}\nStill pass`);
    expect(fake.comments.find((c) => c.id === 2)!.text).toBe("[corbits-triage]: #copied\nNot ours");
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

  test("skips what Data Center has no equivalent for or forbids, with the reason", async () => {
    const fake = fakeBitbucket({ author: BOT });
    expect(await runAction(fake.bb, { request: REQUEST, step: step("labels", { labels: ["x"] }) }, user)).toEqual({ status: "skipped", reason: NO_LABELS });
    expect(await runAction(fake.bb, { request: REQUEST, step: step("approve", {}) }, user)).toEqual({ status: "skipped", reason: OWN_PULL_REQUEST });
    expect(fake.writes).toHaveLength(0);
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
});
