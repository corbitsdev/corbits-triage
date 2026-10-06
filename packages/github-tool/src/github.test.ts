import { describe, expect, test } from "bun:test";
import { githubWrite } from "./sidecar-bundle.js";
import { mergePr, mirror, type GithubFetch } from "./github.js";

type RecordedRequest = { path: string; method: string; body: unknown };

function recorder(respond: (path: string, init?: RequestInit) => unknown) {
  const requests: RecordedRequest[] = [];
  async function gh(path: string, init?: RequestInit): Promise<Response> {
    requests.push({
      path,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return Response.json(respond(path, init));
  }
  return { gh: gh satisfies GithubFetch, requests };
}

function mirrorResponse(comments: unknown[]) {
  return function respond(path: string, init?: RequestInit) {
    if (path.endsWith("/pulls/8") && !init?.method) return { head: { sha: "abc123" } };
    if (path.includes("/comments?per_page")) return comments;
    return { id: 1 };
  };
}

const MIRROR = { repo: "acme/widgets", number: 8, labels: ["needs-decision"], comment: "Duplicate" };

describe("github mirror", () => {
  test("posts a marker comment and leaves the pull request open", async () => {
    const { gh, requests } = recorder(mirrorResponse([]));
    await mirror(gh, { ...MIRROR, close: false });
    expect(requests).toContainEqual({
      path: "/repos/acme/widgets/issues/8/comments",
      method: "POST",
      body: { body: "<!-- corbits-triage:acme/widgets#8@abc123 -->\nDuplicate" },
    });
    expect(requests.some((request) => request.path.endsWith("/pulls/8") && request.method === "PATCH")).toBe(false);
  });

  test("updates a prior marker comment instead of posting another", async () => {
    const { gh, requests } = recorder(mirrorResponse([{ id: 42, body: "<!-- corbits-triage:acme/widgets#8@old -->\nOld" }]));
    const result = await mirror(gh, { ...MIRROR, close: false });
    expect(result.updated).toBe(true);
    expect(requests.some((request) => request.path === "/repos/acme/widgets/issues/comments/42" && request.method === "PATCH")).toBe(true);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  test("close:true closes and never merges", async () => {
    const { gh, requests } = recorder(mirrorResponse([]));
    await mirror(gh, { ...MIRROR, close: true });
    expect(requests).toContainEqual({ path: "/repos/acme/widgets/pulls/8", method: "PATCH", body: { state: "closed" } });
    expect(requests.some((request) => request.path.includes("/merge"))).toBe(false);
  });
});

describe("github write tool approval", () => {
  test("every write except github_mirror_auto asks", () => {
    expect(githubWrite.definitions).toEqual([
      { name: "github_mirror", approval: "ask" },
      { name: "github_mirror_auto" },
      { name: "github_create_review", approval: "ask" },
      { name: "github_create_issue_comment", approval: "ask" },
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
