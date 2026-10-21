import { describe, expect, test } from "bun:test";
import {
  authorTeams,
  codeownersFor,
  codeownersForPr,
  CODE_REVIEW_MARKER,
  getChecks,
  getPostedCodeReview,
  listInstallations,
  listOpenPrs,
  listPrFiles,
  listPrFilesPage,
  listPrTimeline,
  parseCodeowners,
  readMergeStates,
  readPrDiff,
  readRepoDocsPage,
  REPO_DOCS_MAX_BYTES,
  REPO_RULES_MAX_BYTES,
  repoDocs,
  summarizeChecks,
  type GithubFetch,
  type PrFilesPage,
  type RepoDocsPage,
} from "./index.js";

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

test("readMergeStates: one query for every pull request, states named as REST names them, unknown numbers left out", async () => {
  const { gh, requests } = recorder(() => ({
    data: {
      repository: {
        pr1133: { number: 1133, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" },
        pr1125: { number: 1125, state: "MERGED", mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: null },
        pr9: null,
      },
    },
  }));
  expect(await readMergeStates(gh, "acme/widgets", [1133, 1125, 9])).toEqual([
    { number: 1133, open: true, mergeable: true, mergeableState: "blocked", reviewDecision: "REVIEW_REQUIRED" },
    { number: 1125, open: false, mergeable: false, mergeableState: "dirty", reviewDecision: null },
  ]);
  expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /graphql"]);
});

test("readMergeStates: a pull request GitHub answers with an error is left out, and an error naming none leaves them all out", async () => {
  const node = { number: 1, state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null };
  const named = recorder(() => ({ data: { repository: { pr1: node, pr2: { ...node, number: 2 } } }, errors: [{ path: ["repository", "pr2", "reviewDecision"] }] }));
  expect((await readMergeStates(named.gh, "acme/widgets", [1, 2])).map((state) => state.number)).toEqual([1]);
  const unnamed = recorder(() => ({ data: { repository: { pr1: node } }, errors: [{ message: "Something went wrong" }] }));
  expect(await readMergeStates(unnamed.gh, "acme/widgets", [1])).toEqual([]);
});

describe("listInstallations", () => {
  test("an enterprise account is named by its slug, and a suspended installation says so", async () => {
    const { gh } = recorder(() => [
      { id: 1, account: { login: "acme" }, html_url: "https://github.com/a", repository_selection: "all", suspended_at: null },
      { id: 2, account: { slug: "corp" }, html_url: "https://github.com/b", repository_selection: "selected", suspended_at: "2026-10-01T00:00:00Z" },
    ]);
    expect(await listInstallations(gh)).toEqual([
      { id: 1, account: "acme", htmlUrl: "https://github.com/a", selection: "all", suspended: false },
      { id: 2, account: "corp", htmlUrl: "https://github.com/b", selection: "selected", suspended: true },
    ]);
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

describe("getPostedCodeReview", () => {
  const APP = { login: "corbits-triage[bot]", type: "Bot" };
  const review = (id: number, user: object, body: string, commit = "head") => ({ id, user, body, commit_id: commit, html_url: `https://github.com/acme/widgets/pull/8#pullrequestreview-${id}` });
  const comment = (body: string, line: number | null, id: number) => ({ body, path: "src/a.ts", line, original_line: 12, html_url: `https://github.com/acme/widgets/pull/8#discussion_r${id}` });

  test("reads the App's newest marked review; a person's or a non-App account's copied marker is not one", async () => {
    const { gh } = recorder((path) => {
      if (path === "/repos/acme/widgets/pulls/8") return { head: { sha: "head" } };
      if (path.includes("/reviews/2/comments")) return [comment("\n\n**P1 · Null deref**\n\nWhy.", 12, 1), comment("**Stale cache**\n\nWhy.", null, 2)];
      return [
        review(1, APP, `Old\n\n${CODE_REVIEW_MARKER}`),
        review(2, APP, `New\n\n${CODE_REVIEW_MARKER}`, "earlier"),
        review(3, { login: "maya", type: "User" }, CODE_REVIEW_MARKER),
        review(4, { login: "mallory[bot]", type: "User" }, CODE_REVIEW_MARKER),
        review(5, APP, "Approved"),
      ];
    });
    expect(await getPostedCodeReview(gh, "acme/widgets", 8)).toEqual({
      url: "https://github.com/acme/widgets/pull/8#pullrequestreview-2",
      author: "corbits-triage[bot]",
      earlier: true,
      comments: [
        { title: "Null deref", priority: 1, path: "src/a.ts", line: 12, url: "https://github.com/acme/widgets/pull/8#discussion_r1" },
        { title: "Stale cache", path: "src/a.ts", line: null, url: "https://github.com/acme/widgets/pull/8#discussion_r2" },
      ],
    });
  });

  test("no code review sent is null", async () => {
    const { gh } = recorder((path) => (path === "/repos/acme/widgets/pulls/8" ? { head: { sha: "head" } } : [review(3, { login: "maya", type: "User" }, CODE_REVIEW_MARKER)]));
    expect(await getPostedCodeReview(gh, "acme/widgets", 8)).toBeNull();
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

describe("readPrDiff", () => {
  test("a pull request too large for GitHub's diff is built from its files' patches", async () => {
    const { gh } = recorder((path) => (path.includes("/files") ? [{ filename: "src/b.ts", previous_filename: "src/a.ts", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] : new Response("too large", { status: 406 })));
    expect(await readPrDiff(gh, "acme/widgets", 8)).toBe("diff --git a/src/a.ts b/src/b.ts\n--- a/src/a.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-a\n+b\n");
  });
});

describe("listPrFilesPage", () => {
  test("pages every file under the cap, reading an oversized patch across pages", async () => {
    function hunk(line: number) {
      return `@@ -${line} +${line} @@\n+${"x".repeat(3_000)}`;
    }
    function row(filename: string, patch: string) {
      return { filename, status: "modified", additions: 1, deletions: 0, patch };
    }
    const big = `${[1, 2, 3, 4].map(hunk).join("\n")}\n+${"\"".repeat(9_000)}`;
    const { gh } = recorder(() => [row("a.ts", hunk(1)), row("big.ts", big), row("c.ts", hunk(1))]);
    const pages: PrFilesPage[] = [];
    function nextCursor(page: PrFilesPage): { offset: number; patchOffset?: number } | undefined {
      if (page.next === undefined) return undefined;
      if (page.patchNext === undefined) return { offset: page.next };
      return { offset: page.next, patchOffset: page.patchNext };
    }
    let cursor: { offset: number; patchOffset?: number } | undefined = { offset: 0 };
    while (cursor) {
      const page: PrFilesPage = await listPrFilesPage(gh, "acme/widgets", 8, cursor);
      pages.push(page);
      cursor = nextCursor(page);
    }
    expect(pages.every((page) => JSON.stringify(page).length <= 10_000)).toBe(true);
    const files = pages.flatMap((page) => page.files);
    expect([...new Set(files.map((file) => file.path))]).toEqual(["a.ts", "big.ts", "c.ts"]);
    expect(files.filter((file) => file.path === "big.ts").map((file) => file.patch).join("")).toBe(big);
    expect((await listPrFilesPage(gh, "acme/widgets", 8, { patches: false })).files.map((file) => file.patch)).toEqual([undefined, undefined, undefined]);
  });
});

describe("authorTeams", () => {
  const missing = Response.json({ message: "Not Found" }, { status: 404 });

  test("active membership is a member; 404 on an existing team is not; a hidden team, another status or another org is unknown", async () => {
    const replies: Record<string, unknown> = {
      "/orgs/acme/teams/core/memberships/alice": { state: "active" },
      "/orgs/acme/teams/invited/memberships/alice": { state: "pending" },
      "/orgs/acme/teams/gone/memberships/alice": missing,
      "/orgs/acme/teams/gone": { slug: "gone" },
      "/orgs/acme/teams/hidden/memberships/alice": missing,
      "/orgs/acme/teams/hidden": missing,
      "/orgs/acme/teams/secret/memberships/alice": Response.json({ message: "Forbidden" }, { status: 403 }),
    };
    const { gh, requests } = recorder(function respond(path) {
      return replies[path];
    });
    const teams = ["@acme/Core", "invited", "@Acme/gone", "hidden", "secret", "@other/core"];
    expect(await authorTeams(gh, { repo: "acme/widgets", author: "alice", teams })).toEqual({ teams: ["@acme/Core"], unknown: ["hidden", "secret", "@other/core"] });
    expect(requests.map((request) => request.path)).toEqual(Object.keys(replies));
  });

  test("every team of a repository no organization owns is unknown", async () => {
    const { gh } = recorder(function respond() {
      return missing.clone();
    });
    expect(await authorTeams(gh, { repo: "alice/dotfiles", author: "bob", teams: ["core", "ops"] })).toEqual({ teams: [], unknown: ["core", "ops"] });
  });
});

describe("readRepoDocsPage", () => {
  const docs: Array<[string, string]> = [
    ["README.md", "Run it.\n".repeat(1_000)],
    ["docs/guide.md", "Configure it.\n".repeat(2_000)],
    ["docs/CONTRIBUTING.md", "Keep commits small.\n".repeat(500)],
    ["AGENTS.md", "No dynamic imports.\n"],
    [".github/PULL_REQUEST_TEMPLATE/bug.md", "Steps to reproduce.\n"],
    ["packages/hub/AGENTS.md", "Hub only.\n"],
  ];

  function repo() {
    return recorder((path) => {
      if (path.includes("/git/trees/")) return { sha: "tree", tree: docs.map(([doc, text], index) => ({ path: doc, type: "blob", sha: `blob${index}`, size: new TextEncoder().encode(text).byteLength })) };
      const blob = /\/git\/blobs\/blob(\d+)$/.exec(path);
      return blob ? new Response(docs[Number(blob[1])]![1]) : null;
    });
  }

  async function readAll(gh: GithubFetch) {
    const pages: RepoDocsPage[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await readRepoDocsPage(gh, "o/r", { ref: "main", offset });
      pages.push(page);
      offset = page.next;
    }
    return { pages, ...repoDocs(pages) };
  }

  test("reads the root rules first within their own budget and every doc once", async () => {
    const { gh, requests } = repo();
    const { pages, docs: read, rules } = await readAll(gh);
    expect(Object.keys(read)).toEqual(["README.md", "docs/CONTRIBUTING.md", "docs/guide.md"]);
    expect(Object.values(read).reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0)).toBe(REPO_DOCS_MAX_BYTES);
    expect(Object.keys(rules)).toEqual(["AGENTS.md", ".github/PULL_REQUEST_TEMPLATE/bug.md", "docs/CONTRIBUTING.md"]);
    expect(rules["AGENTS.md"]).toBe(docs[3]![1]);
    expect(Object.values(rules).reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0)).toBe(REPO_RULES_MAX_BYTES);
    // A doc in both the docs and the rules is fetched and sent once; only a doc split across pages is fetched again.
    const sent = pages.flatMap((page) => page.docs.map((doc) => doc.path));
    expect(sent.filter((path, index) => sent.indexOf(path) !== index && sent[index - 1] !== path)).toEqual([]);
    expect(requests.filter((request) => request.path.includes("/git/blobs/"))).toHaveLength(sent.length);
  });
});

test("listPrTimeline: comments and reviews by account, upper-case review states, commits without an account left out", async () => {
  const { gh, requests } = recorder(() => [
    { event: "committed", author: { name: "Alice", date: "2026-10-01T00:00:00Z" } },
    { event: "commented", actor: { login: "renovate[bot]", type: "Bot" }, created_at: "2026-10-01T01:00:00Z" },
    { event: "reviewed", user: { login: "bob", type: "User" }, submitted_at: "2026-10-01T02:00:00Z", state: "approved" },
  ]);
  expect(await listPrTimeline(gh, "acme/widgets", 7)).toEqual([
    { kind: "commented", actor: "renovate[bot]", bot: true, at: "2026-10-01T01:00:00Z" },
    { kind: "reviewed", actor: "bob", bot: false, at: "2026-10-01T02:00:00Z", state: "APPROVED" },
  ]);
  expect(requests.map((r) => r.path)).toEqual(["/repos/acme/widgets/issues/7/timeline?per_page=100"]);
});

test("summarizeChecks: a cancelled or stale run has not finished, a failed one fails, a skipped one passes", () => {
  const done = (conclusion: string) => ({ name: conclusion, status: "completed", conclusion });
  expect(summarizeChecks([done("success"), done("cancelled")])).toBe("pending");
  expect(summarizeChecks([done("success"), done("stale")])).toBe("pending");
  expect(summarizeChecks([done("cancelled"), done("failure")])).toBe("failure");
  expect(summarizeChecks([done("success"), done("skipped")])).toBe("success");
});

test("getChecks: only the latest run of each check name counts", async () => {
  function ci(older: string, newer: string) {
    const run = (id: number, conclusion: string) => ({ id, name: "cla", status: "completed", conclusion, started_at: `2026-10-20T0${id}:00:00Z` });
    const { gh } = recorder(() => ({ check_runs: [run(2, newer), run(1, older)] }));
    return getChecks(gh, "acme/widgets", "a".repeat(40));
  }
  expect(summarizeChecks(await ci("cancelled", "success"))).toBe("success");
  expect(summarizeChecks(await ci("success", "failure"))).toBe("failure");
});
