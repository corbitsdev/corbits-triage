import { describe, expect, test } from "bun:test";
import { githubWrite } from "./sidecar-bundle.js";
import {
  codeownersFor,
  codeownersForPr,
  listOpenPrs,
  listPrFiles,
  listPrFilesPage,
  mergePr,
  mirror,
  parseCodeowners,
  upsertTriageComment,
  type GithubFetch,
  type PrFilesPage,
} from "./github.js";

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
    if (path.endsWith("/pulls/8") && !init?.method) return { head: { sha: "abc123" }, labels: labels.map((name) => ({ name })) };
    if (path.includes("/comments?per_page")) return comments;
    if (path.endsWith("/issues/8/comments") && init?.method === "POST") {
      const created = { id: nextId++, user: APP, body };
      comments.push(created);
      return created;
    }
    const edit = /\/issues\/comments\/(\d+)$/.exec(path);
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
  test("every write except github_mirror_auto asks", () => {
    expect(githubWrite.definitions).toEqual([
      { name: "github_mirror", approval: "ask" },
      { name: "github_mirror_auto" },
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

  test("refuses when not mergeable and does not PUT", async () => {
    const { gh, requests } = recorder(function respond() {
      return { mergeable: false, head: { sha: "abc123" }, state: "open" };
    });
    await expect(mergePr(gh, { repo: "acme/widgets", number: 8 })).rejects.toThrow("pull request is not mergeable");
    expect(requests).toEqual([{ path: "/repos/acme/widgets/pulls/8", method: "GET", body: null }]);
  });
});

describe("listOpenPrs", () => {
  test("follows the Link rel=next header across pages", async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, title: `pr ${i + 1}`, head: { sha: `sha${i + 1}` } }));
    async function gh(path: string): Promise<Response> {
      const url = new URL(path, "https://api.github.com");
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page"));
      const headers: Record<string, string> = {};
      if (page * size < all.length) {
        url.searchParams.set("page", String(page + 1));
        headers.link = `<https://api.github.com${url.pathname}${url.search}>; rel="next"`;
      }
      return Response.json(all.slice((page - 1) * size, page * size), { headers });
    }
    const paths: string[] = [];
    const prs = await listOpenPrs(async (path) => (paths.push(path), gh(path)), "acme/widgets");
    expect(paths[1]).toBe("/repos/acme/widgets/pulls?state=open&per_page=100&page=2");
    expect(prs.map((pr) => pr.number)).toEqual(all.map((pr) => pr.number));
  });

  test("a pull request whose GitHub user is missing has a null author", async () => {
    const { gh } = recorder(() => [{ number: 7, title: "T", head: { sha: "s" } }]);
    const [pr] = await listOpenPrs(gh, "acme/widgets");
    expect(pr?.author).toBeNull();
  });
});

describe("codeownersFor", () => {
  const rules = parseCodeowners(`
# default owners
*            @ada
/apps/       @acme/web   # the apps
*.sql        @grace
docs/*       @linus
/apps/hub/legacy.ts
!README.md   @mallory
[Rr]EADME.md @mallory
`);

  test("the last matching rule wins per path, splitting users from team slugs", () => {
    expect(codeownersFor(rules, ["apps/hub/src/server.ts"])).toEqual({ users: [], teams: ["web"] });
    expect(codeownersFor(rules, ["apps/hub/db/001.sql", "docs/intro.md"])).toEqual({ users: ["grace", "linus"], teams: [] });
  });

  test("a trailing * stays one level deep, and an ownerless last rule leaves no owners", () => {
    expect(codeownersFor(rules, ["docs/guides/setup.md"])).toEqual({ users: ["ada"], teams: [] });
    expect(codeownersFor(rules, ["apps/hub/legacy.ts"])).toEqual({ users: [], teams: [] });
    expect(codeownersFor([], ["README.md"])).toEqual({ users: [], teams: [] });
  });

  test("negations and character ranges are ignored as GitHub does", () => {
    expect(codeownersFor(rules, ["README.md", "LICENSE.md"])).toEqual({ users: ["ada"], teams: [] });
  });

  test("a pull request's owners come from its base branch and exclude its author", async () => {
    const { gh, requests } = recorder(function respond(path) {
      if (path.endsWith("/pulls/8")) return { base: { ref: "main" }, user: { login: "ada" } };
      if (path.includes("/contents/")) return new Response("* @ada @grace @acme/core");
      return [{ filename: "src/index.ts" }];
    });
    expect(await codeownersForPr(gh, "acme/widgets", 8)).toEqual({ users: ["grace"], teams: ["core"] });
    expect(requests[1]?.path).toBe("/repos/acme/widgets/contents/.github/CODEOWNERS?ref=main");
  });
});

describe("listPrFiles", () => {
  test("preserves the previous filename for renamed files", async () => {
    const { gh } = recorder(() => [{
      filename: "src/current.ts",
      previous_filename: "src/previous.ts",
      status: "renamed",
      additions: 3,
      deletions: 2,
      patch: "@@ -1 +1 @@",
    }]);
    expect(await listPrFiles(gh, "acme/widgets", 8)).toEqual([{
      path: "src/current.ts",
      previousPath: "src/previous.ts",
      status: "renamed",
      additions: 3,
      deletions: 2,
      patch: "@@ -1 +1 @@",
    }]);
  });
});

describe("listPrFilesPage", () => {
  test("pages every file under the cap, cutting an oversized patch on a hunk boundary", async () => {
    function hunk(line: number) {
      return `@@ -${line} +${line} @@\n+${"x".repeat(3_000)}`;
    }
    function row(filename: string, patch: string) {
      return { filename, status: "modified", additions: 1, deletions: 0, patch };
    }
    const big = [1, 2, 3, 4].map(hunk).join("\n");
    const { gh } = recorder(() => [row("a.ts", hunk(1)), row("big.ts", big), row("c.ts", hunk(1))]);
    const pages: PrFilesPage[] = [];
    for (let offset: number | undefined = 0; offset !== undefined; offset = pages.at(-1)!.next) pages.push(await listPrFilesPage(gh, "acme/widgets", 8, { offset }));
    expect(pages.every((page) => JSON.stringify(page).length <= 10_000)).toBe(true);
    expect(pages.flatMap((page) => page.files.map((file) => file.path))).toEqual(["a.ts", "big.ts", "c.ts"]);
    expect(pages[1]!.files[0]).toMatchObject({ patch: [1, 2].map(hunk).join("\n"), patchTruncated: true });
    expect((await listPrFilesPage(gh, "acme/widgets", 8, { patches: false })).files.map((file) => file.patch)).toEqual([undefined, undefined, undefined]);
  });
});
