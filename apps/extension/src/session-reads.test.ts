import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_REVIEW_MARKER, getPostedCodeReview } from "@corbits/github-reads";
import { emptyPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub } from "@corbits/triage-workflows/evals/serve";
import { runChecks } from "./run-checks.ts";
import { sessionGithub, type Session } from "./session-reads.ts";

const PR = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/godotenv-262.json"), "utf8")) as Snapshot;
const SHA = "c0ffee".padEnd(40, "0");
// Tag characters spell text no reader sees; only the commit's body, past its headline, carries them.
const HIDDEN = "\u{E0041}\u{E0042}\u{E0043}";

// The pull request's fields github.com's page data gives, as the session's page reader answers them.
const PAGE_PULL = ["number", "title", "body", "body_html", "state", "merged", "draft", "user", "author_association", "head", "base", "mergeable", "requested_reviewers", "requested_teams", "assignees", "additions", "deletions", "changed_files", "labels"];

/** github.com as the person signed in sees a private copy of the fixture; nothing answers on api.github.com. */
function signedIn(unreadable: RegExp | null, rendered = true, merge?: string): Session {
  const served = fixtureGithub(PR, {});
  const headline = PR.commits[0]!.split("\n")[0]!;

  async function page(path: string): Promise<string | null> {
    if (unreadable?.test(path)) throw new Error(`github.com's page data changed for ${path}`);
    const { pathname } = new URL(path, "https://api.github.com");
    if (pathname.includes("/contents")) return "[]";
    if (pathname === `/repos/${PR.repo}/pulls/${PR.number}`) {
      const pull = (await (await served(new URL(`https://api.github.com${path}`))).json()) as Record<string, unknown>;
      const fields = PAGE_PULL.filter((field) => rendered || field !== "body_html");
      return JSON.stringify(Object.fromEntries(fields.map((field) => [field, pull[field] ?? null])));
    }
    if (pathname.endsWith("/commits")) {
      const rows = [SHA, ...(merge ? [merge] : [])].map((sha) => ({ sha, commit: { message: headline, committer: { date: "2026-10-01T00:00:00Z" } }, author: { login: PR.author } }));
      return JSON.stringify(rows);
    }
    return (await served(new URL(`https://api.github.com${path}`))).text();
  }

  async function site(url: string): Promise<Response> {
    if (url.endsWith(".patch")) return new Response(`From ${SHA} Mon Sep 17 00:00:00 2001\nFrom: A <a@example.com>\nSubject: [PATCH] ${headline}\n\nmore${HIDDEN}\n---\n file | 1 +\n-- \n2.43.0\n`);
    if (!url.endsWith(".diff")) return new Response(null, { status: 404 });
    const files = (await (await served(new URL(`https://api.github.com/repos/${PR.repo}/pulls/${PR.number}/files`))).json()) as Array<{ filename: string; patch: string }>;
    return new Response(files.map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`).join(""));
  }

  return { page, site };
}

const pack = { ...emptyPack(PR.repo), checks: { "max-files-changed": { enabled: true, maxFiles: 1 }, "hidden-content": { enabled: true }, "ci-green": { enabled: true } } };

test("a private pull request is checked through the session with no token, whole commit messages included", async () => {
  const { checks } = await runChecks({ repo: PR.repo, number: PR.number }, sessionGithub(signedIn(null), null).gh, pack);
  const byId = Object.fromEntries(checks.map((check) => [check.check, check]));
  expect(byId["max-files-changed"]).toMatchObject({ result: "fail", evidence: ["2 files (max 1)"] });
  expect(byId["hidden-content"]?.result).toBe("fail");
});

test("a fact the session cannot read, with no token, leaves the pull request unchecked rather than passed", async () => {
  const { gh } = sessionGithub(signedIn(/\/check-runs/), null);
  await expect(runChecks({ repo: PR.repo, number: PR.number }, gh, pack)).rejects.toThrow("could not read the checks of #262");
});

test("without GitHub's rendering of the description, with no token, the pull request is not checked and says why", async () => {
  const reads = sessionGithub(signedIn(null, false), null);
  await expect(runChecks({ repo: PR.repo, number: PR.number }, reads.gh, pack)).rejects.toThrow("github_get_pr failed");
  expect(reads.missed()[0]).toContain("rendered description, which can't be read without a GitHub token. Save a GitHub token");
});

test("a merge commit, left out of the .patch, with no token, leaves the pull request unchecked and says why", async () => {
  const reads = sessionGithub(signedIn(null, true, "f00d".padEnd(40, "0")), null);
  await expect(runChecks({ repo: PR.repo, number: PR.number }, reads.gh, pack)).rejects.toThrow("could not read the commits");
  expect(reads.missed()[0]).toContain("(such as a merge commit) is not in github.com's .patch, so it can't be read without a GitHub token. Save a GitHub token");
});

const POSTED = { id: 7, user: { login: "corbits[bot]", type: "Bot" }, body: `${CODE_REVIEW_MARKER}\nOne defect.`, html_url: `https://github.com/${PR.repo}/pull/${PR.number}#pullrequestreview-7`, state: "COMMENTED", submitted_at: "2026-10-01T00:00:00Z", commit_id: SHA };

/** github.com's page lists the App's review as the session's page reader answers it: without its body. */
function reviewedOnPage(): Session {
  const session = signedIn(null);
  async function page(path: string): Promise<string | null> {
    if (path.includes("/reviews/")) return null;
    if (path.includes("/reviews")) return JSON.stringify([{ user: { login: POSTED.user.login }, state: POSTED.state, submitted_at: POSTED.submitted_at, commit_id: SHA }]);
    return session.page(path);
  }
  return { page, site: session.site };
}

async function api(path: string): Promise<Response> {
  return Response.json(path.includes("/reviews/") ? [] : [POSTED]);
}

test("with a token saved, the App's posted code review is read from the API, as the page gives no review's body", async () => {
  expect(await getPostedCodeReview(sessionGithub(reviewedOnPage(), api).gh, PR.repo, PR.number)).toMatchObject({ url: POSTED.html_url, author: POSTED.user.login, comments: [] });
  expect(await getPostedCodeReview(sessionGithub(reviewedOnPage(), null).gh, PR.repo, PR.number)).toBeNull();
});
