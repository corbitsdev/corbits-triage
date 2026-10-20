import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Site } from "@corbits/pr-code-review/findings";
import { shownBody, visibleText } from "@corbits/triage-contracts";

const LABELS = new URL("./labels/", import.meta.url).pathname;
const CASES = new URL("./cases.json", import.meta.url).pathname;
const CACHE = new URL("./.cache/", import.meta.url).pathname;

export type { Site } from "@corbits/pr-code-review/findings";

export type Reach = "diff" | "repo" | "intent";

export interface Bug {
  id: string;
  reach: Reach;
  sites: Site[];
}

interface AnswerKey {
  id: string;
  verdict: "defect" | "clean";
  bugs: Bug[];
}

/** A case's pull request: its repository, number and the base and head it was labelled at. */
interface CaseStub {
  id: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface CaseKey {
  id: string;
  kind: AnswerKey["verdict"];
  bugs: Bug[];
}

export interface PullRequest {
  title: string;
  description: string;
  diff: string;
}

export type Case = CaseKey & PullRequest;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function gh(...args: string[]): string {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** The diff from baseSha to headSha; for a fork or open pull request whose head the compare cannot see, the pull request's own diff. */
function diffOf(stub: CaseStub, headSha: string): string {
  try {
    return gh("-H", "Accept: application/vnd.github.diff", `repos/${stub.repo}/compare/${stub.baseSha}...${stub.headSha}`);
  } catch (error) {
    if (headSha !== stub.headSha) throw new Error(`compare failed and pull/${stub.number}/head is ${headSha}, not ${stub.headSha}`, { cause: error });
    return gh("-H", "Accept: application/vnd.github.diff", `repos/${stub.repo}/pulls/${stub.number}`);
  }
}

/** The title and description as the hub sends them: without what GitHub hides. */
function fetchPr(stub: CaseStub): PullRequest {
  const pr = JSON.parse(gh("-H", "Accept: application/vnd.github.full+json", `repos/${stub.repo}/pulls/${stub.number}`)) as { title: string; body: string | null; body_html?: string; head: { sha: string } };
  const description = shownBody({ body: pr.body, bodyHtml: pr.body_html }, "github");
  if (description === undefined) throw new Error(`${stub.repo}#${stub.number}: GitHub returned no rendered body`);
  return { title: visibleText(pr.title), description, diff: diffOf(stub, pr.head.sha) };
}

function stubOf(id: string): CaseStub {
  const stub = readJson<CaseStub[]>(CASES).find((s) => s.id === id);
  if (!stub) throw new Error(`no case ${id} in cases.json`);
  return stub;
}

/** The repository and head sha of case `id`. */
export function headOf(id: string): { repo: string; sha: string } {
  const { repo, headSha } = stubOf(id);
  return { repo, sha: headSha };
}

/** The pull request of case `id`, fetched once and cached. */
export function pullRequestOf(id: string): PullRequest {
  const cached = join(CACHE, `${id}.shown.json`);
  if (existsSync(cached)) return readJson(cached);
  const pr = fetchPr(stubOf(id));
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify(pr));
  return pr;
}

/** The answer keys in evals/labels/, or those of `only`. */
export function loadKeys(only?: readonly string[]): CaseKey[] {
  const ids = readdirSync(LABELS)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const unknown = only?.filter((id) => !ids.includes(id)) ?? [];
  if (unknown.length > 0) throw new Error(`no answer key: ${unknown.join(", ")}`);
  function caseKey(id: string): CaseKey {
    const key = readJson<AnswerKey>(join(LABELS, `${id}.json`));
    return { id, kind: key.verdict, bugs: key.bugs };
  }
  return ids.filter((id) => !only || only.includes(id)).map(caseKey);
}

export function loadCases(only?: readonly string[]): Case[] {
  return loadKeys(only).map((key) => ({ ...key, ...pullRequestOf(key.id) }));
}
