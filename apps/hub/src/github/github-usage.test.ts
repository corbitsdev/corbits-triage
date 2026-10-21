import { describe, expect, test } from "bun:test";
import { INSTALLATION_SELECTOR_HEADER } from "@corbits/github-reads";
import { createGithubUsage, GithubRateLimited } from "./github-usage.js";

const SELECTED = { headers: { [INSTALLATION_SELECTOR_HEADER]: "7" } };

describe("github usage", () => {
  test("a rate limit holds every request to that installation alone until its reset, on GitHub's clock, then lets them through", async () => {
    let clock = 1_000_000;
    // GitHub's clock runs 30s ahead of the hub's, so its reset 60s away lands 30s from now here.
    const limited = new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060", date: new Date(1_030_000).toUTCString() },
    });
    const responses = [limited, Response.json({}), Response.json({}), Response.json({})];
    let fetches = 0;
    const usage = createGithubUsage(() => clock);
    const gh = usage.gate(async function github() {
      fetches += 1;
      return responses.shift()!;
    });
    const tenantB = { headers: { [INSTALLATION_SELECTOR_HEADER]: "8" } };

    await expect(gh("/repos/a/r/pulls", SELECTED)).rejects.toBeInstanceOf(GithubRateLimited);
    await expect(gh("/repos/a/r/pulls/1", SELECTED)).rejects.toMatchObject({ resetAt: 1_030_000 });
    expect(fetches).toBe(1);
    expect((await gh("/repos/b/r/pulls", tenantB)).status).toBe(200);
    expect((await gh("/repos/b/r/pulls")).status).toBe(200);
    expect(fetches).toBe(3);

    clock = 1_030_000;
    expect((await gh("/repos/a/r/pulls/1", SELECTED)).status).toBe(200);
    expect(fetches).toBe(4);
  });

  test("a secondary limit without Retry-After holds the installation for a minute", async () => {
    const usage = createGithubUsage(() => 0);
    const gh = usage.gate(async function github() {
      return Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403 });
    });
    await expect(gh("/repos/a/r/pulls", SELECTED)).rejects.toMatchObject({ resetAt: 60_000 });
  });

  test("the minute's line counts calls by route and installation, then starts again", async () => {
    const usage = createGithubUsage(() => 0);
    const gh = usage.gate(async function github() {
      return Response.json({}, { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "3600" } });
    });
    await gh("/repos/o/r/pulls/12/files?per_page=100&page=2", SELECTED);
    await gh("/repos/o/other/pulls/3/files?per_page=100", SELECTED);
    await gh("/repos/o/r/contents/.github/CODEOWNERS?ref=main", { ...SELECTED, method: "GET" });
    await gh("/app/installations");

    expect(usage.flush()).toEqual({
      level: "info",
      msg: "github_calls",
      routes: { "GET /repos/:owner/:repo/pulls/:n/files": 2, "GET /repos/:owner/:repo/contents/:path": 1, "GET /app/installations": 1 },
      installations: { "7": 3, unselected: 1 },
      blocked: {},
      rateLimits: { "7": { remaining: 4990, resetAt: "1970-01-01T01:00:00.000Z" } },
    });
    expect(usage.flush()).toBeUndefined();
  });
});
