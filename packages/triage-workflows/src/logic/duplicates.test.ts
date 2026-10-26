import { describe, expect, test } from "bun:test";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import type { EffectContext } from "@intx/workflow";
import { readCheckPack, readPolicyFile } from "@corbits/triage-contracts";
import { readFacts } from "../actions/facts.js";
import { rules } from "../actions/index.js";
import { deriveState, type PrFacts } from "./checks.js";
import { MAX_OPEN_PULLS, overlapping } from "./duplicates.js";
import type { HostCall } from "./host.js";
import { NO_FACTS } from "./item.js";
import { prepareQualityEvaluation } from "./quality.js";
import { parseAnswers, renderVerdict } from "./render.js";

const ctx = {} as EffectContext;
const signal = new AbortController().signal;

const NO_DUPLICATE = "  - check: no-duplicate\n    text: No duplicate.\n    reason: Copies.\n    evidence: [maintainer-stated]\n";
const JUDGED = "  - check: duplicates-open-pull-request\n    text: Not already open.\n    reason: Copies.\n    evidence: [maintainer-stated]\n";

function packOf(...rows: string[]) {
  return readCheckPack(readPolicyFile(`rules:\n${rows.join("")}`, "acme/widgets"));
}

/** An open pull request the fake host lists on `main`; a field left out is one it cannot read. */
type Listed = { number: number; title: string; sha?: string; draft?: boolean; hash?: string; commits?: string[]; paths?: string[] };

const TITLE = "Add rate limits to the login route";
const OWN: Listed = { number: 20, title: TITLE, sha: "own", hash: "same", commits: ["c1", "c2"], paths: ["src/login.ts", "bun.lock"] };

/** The host for `own` beside `others`, answering each by call id and recording every call. */
function host(others: Listed[], calls: ToolCall[], own: Listed): HostCall {
  const n = own.number;
  const byNumber = new Map([own, ...others].map((pull) => [pull.number, pull]));
  const listing = { prs: [own, ...others].map(({ number, title, sha, draft }) => ({ number, title, sha: sha ?? `head${number}`, draft: draft === true })) };
  const results: Record<string, unknown> = {
    github_list_open_prs: listing,
    "open:main": listing,
    "docs:0": { docs: [], rules: [], ref: "tree" },
    [`pr:${n}`]: { title: TITLE, author: "octocat", sha: own.sha, base: "main", state: "open", draft: false, mergeable: true },
    [`reviews:${n}`]: { reviews: [] },
    [`comments:${n}`]: { comments: [] },
    [`commits:${n}`]: { commits: [] },
    [`checks:${n}`]: { checks: [] },
    [`files:${n}:0`]: { files: [{ path: "src/login.ts", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+limit" }, { path: "bun.lock", additions: 1, deletions: 1 }] },
  };
  return async function answer(asked) {
    calls.push(asked);
    const [kind, number] = asked.id.split(":");
    const pull = byNumber.get(Number(number));
    const read: Record<string, unknown> = {
      "diff-hash": { hash: pull?.hash },
      "open-commits": { commits: pull?.commits?.map((sha) => ({ sha })) },
      "open-files": { files: pull?.paths?.map((path) => ({ path })) },
    };
    return { callId: asked.id, content: read[kind!] ?? results[asked.id], isError: kind === "open-files" && pull?.paths === undefined } as ToolResult;
  };
}

async function ruled(others: Listed[], pack = packOf(NO_DUPLICATE, JUDGED), calls: ToolCall[] = [], own = OWN) {
  const read = await readFacts({ kind: "pr", repo: "acme/widgets", prNumber: own.number, policy: { enabled: true }, checkPack: pack }, () => host(others, calls, own));
  return rules(read, ctx, signal);
}

function noDuplicate(items: Awaited<ReturnType<typeof ruled>>["items"]) {
  return items[0]!.det.checks.find((check) => check.check === "no-duplicate");
}

describe("no-duplicate", () => {
  test("fails on an earlier open pull request with the same head, diff or commits, reading further only those whose paths could match", async () => {
    const calls: ToolCall[] = [];
    const { items } = await ruled([
      { number: 9, title: "Login limits", hash: "same", commits: ["c9"], paths: ["src/login.ts", "bun.lock"] },
      { number: 10, title: "Rebased copy", hash: "other", commits: ["c2", "c1"], paths: ["bun.lock", "src/login.ts"] },
      { number: 11, title: "Same branch", sha: "own", paths: ["src/other.ts"] },
      { number: 12, title: "Draft copy", draft: true, hash: "same", paths: ["src/login.ts", "bun.lock"] },
      { number: 13, title: "Docs", hash: "same", paths: ["docs/login.md"] },
      { number: 21, title: "Later copy", hash: "same", paths: ["src/login.ts", "bun.lock"] },
    ], packOf(NO_DUPLICATE), calls);
    expect(noDuplicate(items)).toMatchObject({ result: "fail", reason: "has the same changes as #11, #9, #10" });
    expect(calls.filter((call) => call.id.startsWith("diff-hash:")).map((call) => call.id)).toEqual(["diff-hash:20", "diff-hash:9", "diff-hash:10"]);
    expect(calls.some((call) => call.id === "open-files:12" || call.id === "open-files:21")).toBe(false);
  });

  test("compares on what was read: another's unread diff passes it, and another's unread paths or its own unread changes leave it unconfirmed", async () => {
    const unreadDiff = await ruled([{ number: 9, title: "Other", hash: "other", paths: ["src/login.ts", "bun.lock"] }], packOf(NO_DUPLICATE));
    expect(noDuplicate(unreadDiff.items)).toMatchObject({ result: "pass" });
    const unreadPaths = await ruled([{ number: 9, title: "Other", hash: "other", paths: ["src/login.ts", "bun.lock"] }, { number: 10, title: "Unlisted", hash: "same" }], packOf(NO_DUPLICATE));
    expect(noDuplicate(unreadPaths.items)).toMatchObject({ result: "unconfirmed", reason: "could not read the changed paths of #10" });
    const unreadOwn = await ruled([{ number: 9, title: "Other", hash: "other", commits: ["c9"], paths: ["src/login.ts", "bun.lock"] }], packOf(NO_DUPLICATE), [], { ...OWN, hash: undefined, commits: undefined });
    expect(noDuplicate(unreadOwn.items)).toMatchObject({ result: "unconfirmed", reason: "could not read this pull request's changes" });
  });

  test("is unconfirmed past the open pull requests it reads, reading none of them", async () => {
    const calls: ToolCall[] = [];
    const many = Array.from({ length: MAX_OPEN_PULLS + 1 }, (_, index) => ({ number: 1 + index, title: "Other", hash: "same", paths: ["src/login.ts", "bun.lock"] }));
    const { items } = await ruled(many, packOf(NO_DUPLICATE), calls, { ...OWN, number: 200 });
    expect(noDuplicate(items)).toMatchObject({ result: "unconfirmed", reason: "could not compare the open pull requests: more than 100 open pull requests on main" });
    expect(calls.some((call) => call.id.startsWith("open-files:") || call.id.startsWith("diff-hash:"))).toBe(false);
  });

  test("the comment names the pull request it duplicates", async () => {
    const { items } = await ruled([{ number: 9, title: "Copy", hash: "same", commits: ["c9"], paths: ["src/login.ts", "bun.lock"] }], packOf(NO_DUPLICATE));
    const { facts, det } = items[0]!;
    const verdict = renderVerdict({ repoSource: "github", author: facts.author, repo: facts.repo, headSha: facts.headSha, det });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.feedback).toContain("@octocat, please address the following:\n- has the same changes as #9");
  });
});

describe("duplicates-open-pull-request", () => {
  test("shortlists open pull requests sharing a path, then two title words, leaving out lockfiles and common words", () => {
    const others = [
      { number: 20, title: "Bump deps", paths: ["bun.lock"] },
      { number: 21, title: "Add limits to the login route", paths: ["docs/login.md"] },
      { number: 22, title: "Refactor", paths: ["src/login.ts", "src/session.ts"] },
      { number: 23, title: "Login page", paths: ["web/login.tsx"] },
      { number: 24, title: "Rate the session", paths: ["src/session.ts", "src/login.ts"] },
      { number: 25, title: "Request this from that", paths: ["web/a.ts"] },
    ];
    expect(overlapping(`${TITLE} with this request`, ["src/login.ts", "src/session.ts", "bun.lock"], others).map((pull) => pull.number)).toEqual([24, 22, 21]);
  });

  test("asks one Score per earlier shortlisted pull request in a request of its own", async () => {
    const { items, chunks } = await ruled([
      { number: 9, title: "Login limits", paths: ["src/login.ts"] },
      { number: 10, title: "Unrelated", paths: ["README.md"] },
      { number: 21, title: "Later login limits", paths: ["src/login.ts"] },
    ], packOf(JUDGED));
    expect(items[0]!.facts.openPulls).toEqual({ overlapping: [{ number: 9, title: "Login limits", paths: ["src/login.ts"] }] });
    const asked = chunks.at(-1)!;
    expect(asked.questions.map((question) => question.id)).toEqual(["duplicates-open-pull-request-001", "instructed"]);
    expect(asked.state).toMatchObject({ pullRequest: { title: TITLE, paths: ["src/login.ts", "bun.lock"] }, repository: { openPullRequests: [{ number: 9 }] } });
  });

  test("names the open pull request most likely the same change, and asks a maintainer", () => {
    const pack = packOf(JUDGED);
    const facts: PrFacts = {
      ...NO_FACTS,
      repo: "acme/widgets",
      number: 20,
      title: TITLE,
      author: "octocat",
      headSha: "abc",
      mergeable: true,
      paths: ["src/login.ts"],
      openPulls: { overlapping: [{ number: 9, title: "Login limits", paths: ["src/login.ts"] }, { number: 13, title: "Rate limits", paths: ["src/login.ts"] }] },
    };
    const det = deriveState(facts, undefined, pack);
    const { plan } = prepareQualityEvaluation(facts, det.sources);
    const levels = { 0: "same change", 1: "overlaps", 2: "unrelated" };
    function score(id: string, probabilities: number[]): string {
      return JSON.stringify({ id, type: "score", score: 1, legend: levels, probabilities: Object.fromEntries(probabilities.map((p, index) => [String(index), p])), confidence: 0.9 });
    }
    const answers = parseAnswers([score("duplicates-open-pull-request-001", [0.2, 0.5, 0.3]), score("duplicates-open-pull-request-002", [0.8, 0.15, 0.05]), JSON.stringify({ id: "instructed", type: "noul", noul: 0.1 })].join(""));
    const verdict = renderVerdict({ repoSource: "github", author: "octocat", repo: "acme/widgets", headSha: "abc", det, answers, plan });
    expect(verdict.checks.find((check) => check.check === "duplicates-open-pull-request")).toMatchObject({ result: "fail", reason: "looks like the same change as #13", onFail: "ask", output: { kind: "level", level: "same change" } });
    expect(verdict.verdict).toBe("unsure");
    expect(verdict.feedback).toContain("Asking a maintainer about:\n- looks like the same change as #13");
  });
});
