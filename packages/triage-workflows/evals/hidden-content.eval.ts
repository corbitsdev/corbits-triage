// Hidden-content eval: replays real merged pull requests and crafted attempts to hide text through the deployed
// pr-triage definition on Interchange's local runner, with only the hidden-content rule on, so no model is asked. Each
// case expects the rule's result and, for an attempt, the evidence it names. `--record` reads the real pull requests,
// and their repositories' pull request templates, through `gh` into the fixture.
//
//   bun run eval:hidden-content [--record]   (in packages/triage-workflows)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { evaluate, type Case, type CheckFn } from "@corbits/evals";
import { readPrTemplates, type GithubFetch } from "@corbits/github-reads";
import { emptyPack, type CheckPack } from "../../triage-contracts/src/index.js";
import type { Snapshot } from "./cases.js";
import { runDefinition, type Endpoint } from "./run-definition.js";
import { fixtureGithub, triggerMail } from "./serve.js";

// No rule asks the model, so nothing reaches this endpoint.
const NO_MODEL: Endpoint = { kind: "custom", url: "https://inference.invalid", model: "none" };
const REPO = "acme/widgets";
const ORG_TEMPLATES = "acme/.github";

const here = new URL(".", import.meta.url).pathname;
const casesPath = `${here}hidden-content.jsonl`;
const fixturePath = `${here}hidden-content.json.gz`;

/** A recorded pull request by `owner/name#number`, or one written out; a recorded one takes only what the case leaves unset. */
interface Input {
  pull?: string;
  title?: string;
  body?: string;
  bodyHtml?: string;
  commits?: string[];
  paths?: string[];
  /** The repository's pull request templates; a recorded pull request has those GitHub offers its repository. */
  templates?: string[];
  /** The templates in the owner's `.github` repository. */
  orgTemplates?: string[];
}

interface Outcome {
  result: string;
  evidence: string[];
}

type Recorded = Pick<Snapshot, "title" | "body" | "bodyHtml" | "author" | "commits">;
type Fixture = { pulls: Record<string, Recorded>; templates: Record<string, string[]> };

function gh(path: string, accept = "application/vnd.github+json"): any {
  const out = Bun.spawnSync(["gh", "api", "-H", `Accept: ${accept}`, path]);
  if (out.exitCode !== 0) throw new Error(`gh api ${path}: ${out.stderr.toString()}`);
  Bun.sleepSync(1000);
  return JSON.parse(out.stdout.toString());
}

function recorded(key: string): Recorded {
  const [repo, number] = key.split("#") as [string, string];
  const pull = gh(`repos/${repo}/pulls/${number}`, "application/vnd.github.full+json");
  const commits: any[] = gh(`repos/${repo}/pulls/${number}/commits?per_page=100`);
  return { title: pull.title, body: pull.body ?? "", bodyHtml: pull.body_html ?? "", author: pull.user.login, commits: commits.map((row) => String(row.commit.message)) };
}

function ghToken(): string {
  const out = Bun.spawnSync(["gh", "auth", "token"]);
  if (out.exitCode !== 0) throw new Error(`gh auth token: ${out.stderr.toString()}`);
  return out.stdout.toString().trim();
}

/** GitHub read live as the signed-in `gh` user, a request a second. */
function liveGithub(): GithubFetch {
  const token = ghToken();
  return async function github(path: string, init?: RequestInit): Promise<Response> {
    await Bun.sleep(1000);
    return fetch(`https://api.github.com${path}`, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });
  };
}

async function record(keys: string[]): Promise<Fixture> {
  const repos = [...new Set(keys.map((key) => key.split("#")[0]!))];
  const live = liveGithub();
  const templates: Fixture["templates"] = {};
  for (const repo of repos) templates[repo] = await readPrTemplates(live, repo);
  return { pulls: Object.fromEntries(keys.map((key) => [key, recorded(key)])), templates };
}

const cases = readFileSync(casesPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Case<Input, Outcome>);
const keys = cases.flatMap((row) => (row.input.pull === undefined ? [] : [row.input.pull]));
if (process.argv.includes("--record")) writeFileSync(fixturePath, gzipSync(JSON.stringify(await record(keys))));
if (!existsSync(fixturePath)) throw new Error("no fixture; run with --record");
const fixture = JSON.parse(gunzipSync(readFileSync(fixturePath)).toString()) as Fixture;

function templatesOf(input: Input): Record<string, string[]> {
  if (input.pull === undefined) return { [REPO]: input.templates ?? [], [ORG_TEMPLATES]: input.orgTemplates ?? [] };
  const templates = fixture.templates[input.pull.split("#")[0]!];
  if (!templates) throw new Error(`${input.pull}'s templates are not recorded; run with --record`);
  return { [REPO]: templates };
}

function snapshot(input: Input): Snapshot {
  const base = input.pull === undefined ? { title: "Fix the parser", body: "", bodyHtml: "", author: "octocat", commits: ["fix: parser"] } : fixture.pulls[input.pull];
  if (!base) throw new Error(`${input.pull} is not recorded; run with --record`);
  const files = (input.paths ?? []).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0 }));
  return { repo: REPO, number: 8, docs: {}, files, title: input.title ?? base.title, body: input.body ?? base.body, bodyHtml: input.bodyHtml ?? base.bodyHtml, author: base.author, commits: input.commits ?? base.commits };
}

function pack(repo: string): CheckPack {
  return { ...emptyPack(repo), checks: { "hidden-content": { enabled: true } } };
}

async function triage(input: Input): Promise<Outcome> {
  const pr = snapshot(input);
  const { verdict } = await runDefinition({ fetch: fixtureGithub(pr, templatesOf(input)), apiKey: "none", endpoint: NO_MODEL, triggerPayload: triggerMail(pr, pack(pr.repo)) });
  const row = verdict.checks.find((check) => check.check === "hidden-content");
  return { result: row?.result ?? "missing", evidence: row?.evidence ?? [] };
}

const result: CheckFn<Input, Outcome, Outcome> = function result({ output, expect }) {
  const pass = output.result === expect!.result;
  return { pass, value: pass ? 1 : 0, label: output.result, explanation: output.evidence.join("; ") };
};

const evidence: CheckFn<Input, Outcome, Outcome> = function evidence({ output, expect }) {
  const pass = JSON.stringify(output.evidence) === JSON.stringify(expect!.evidence ?? []);
  return { pass, value: pass ? 1 : 0, explanation: output.evidence.join("; ") };
};

await evaluate("hidden-content", { run: triage, cases, checks: { result, evidence }, concurrency: 4, timeout: "1m" });
