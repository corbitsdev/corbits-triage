import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyPack } from "@corbits/triage-contracts";
import type { Snapshot } from "@corbits/triage-workflows/evals/cases";
import { fixtureGithub } from "@corbits/triage-workflows/evals/serve";
import { runChecks } from "./run-checks.ts";
import { sessionGithub, type Session } from "./session-reads.ts";

const PR = JSON.parse(readFileSync(join(import.meta.dir, "../../../packages/pr-workflow-anthropic/fixtures/godotenv-262.json"), "utf8")) as Snapshot;
const SHA = "c0ffee".padEnd(40, "0");
// Tag characters spell text no reader sees; only the commit's body, past its headline, carries them.
const HIDDEN = "\u{E0041}\u{E0042}\u{E0043}";

/** github.com as the person signed in sees a private copy of the fixture; nothing answers on api.github.com. */
function signedIn(unreadable: RegExp | null): Session {
  const served = fixtureGithub(PR, {});
  const headline = PR.commits[0]!.split("\n")[0]!;

  async function page(path: string): Promise<string | null> {
    if (unreadable?.test(path)) throw new Error(`github.com's page data changed for ${path}`);
    const { pathname } = new URL(path, "https://api.github.com");
    if (pathname.includes("/contents")) return "[]";
    if (pathname.endsWith("/commits")) return JSON.stringify([{ sha: SHA, commit: { message: headline, committer: { date: "2026-10-01T00:00:00Z" } }, author: { login: PR.author } }]);
    return (await served(new URL(`https://api.github.com${path}`))).text();
  }

  async function site(url: string): Promise<Response> {
    if (url.endsWith(".patch")) return new Response(`From ${SHA} Mon Sep 17 00:00:00 2001\nFrom: A <a@example.com>\nSubject: [PATCH] ${headline}\n\nmore${HIDDEN}\n---\n file | 1 +\n`);
    if (!url.endsWith(".diff")) return new Response(null, { status: 404 });
    const files = (await (await served(new URL(`https://api.github.com/repos/${PR.repo}/pulls/${PR.number}/files`))).json()) as Array<{ filename: string; patch: string }>;
    return new Response(files.map((file) => `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}\n`).join(""));
  }

  return { page, site };
}

const pack = { ...emptyPack(PR.repo), checks: { "max-files-changed": { enabled: true, maxFiles: 1 }, "hidden-content": { enabled: true }, "ci-green": { enabled: true } } };

test("a private pull request is checked through the session with no token, whole commit messages included", async () => {
  const { checks } = await runChecks({ repo: PR.repo, number: PR.number }, sessionGithub(signedIn(null), null), pack);
  const byId = Object.fromEntries(checks.map((check) => [check.check, check]));
  expect(byId["max-files-changed"]).toMatchObject({ result: "fail", evidence: ["2 files (max 1)"] });
  expect(byId["hidden-content"]?.result).toBe("fail");
});

test("a fact the session cannot read, with no token, leaves the pull request unchecked rather than passed", async () => {
  const gh = sessionGithub(signedIn(/\/check-runs/), null);
  await expect(runChecks({ repo: PR.repo, number: PR.number }, gh, pack)).rejects.toThrow("could not read the checks of #262");
});
