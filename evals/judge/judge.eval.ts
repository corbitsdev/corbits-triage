// Judge eval: replays frozen pull requests through the deployed pr-triage definition on Interchange's local runner (the
// production step invoker, agents and directors, with GitHub served from the snapshot and the judge calling the
// production decision model) and checks each judged rule's answer and the verdict against its label. The judge is not
// deterministic, so each may miss a few cases. Each judge call is attempted once, as deployed: the judge director answers
// an inference error as a judge error instead of failing its step, so the step's retry never runs and those rules stay unsure.
//
//   bun run eval:judge
import { EvalFailure, evaluate, type CheckFn, type Report } from "@corbits/evals";
import { readFileSync } from "node:fs";
import { mailPayload } from "../../apps/hub/src/github/bridge.js";
import { DEFAULT_REPO_POLICY, emptyPack, TRIAGE_MAIL_SENDER, type CheckPack } from "../../packages/triage-contracts/src/index.js";
import { PR_TRIAGE_ADDRESS } from "../../packages/triage-workflows/src/pr-triage.js";
import { MODEL_CHECKS, SCORED, variant, type CaseInput, type Expected, type Scored, type Snapshot, type StoredSnapshot } from "./cases.js";
import { runDefinition, type Endpoint } from "./run-definition.js";

// The OpenCode Zen preset the production workspace's decision model uses.
const ENDPOINT: Endpoint = { kind: "custom", url: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" };
const DOMAIN = "triage.test";
function requiredApiKey(): string {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) throw new Error("OPENCODE_API_KEY is not set");
  return key;
}
const apiKey = requiredApiKey();

const here = new URL(".", import.meta.url).pathname;

type Outcomes = Record<Scored, "pass" | "fail" | "unsure">;

function snapshot(number: number): Snapshot {
  const stored = JSON.parse(readFileSync(`${here}pulls/${number}.json`, "utf8")) as StoredSnapshot;
  const docs = Object.fromEntries(Object.entries(stored.docs).map(([path, hash]) => [path, readFileSync(`${here}docs/${hash}.md`, "utf8")]));
  return { ...stored, docs };
}

/** Serves a snapshot as GitHub would: the open pull request, its paged file rows, and its docs as the default branch's tree and blobs. */
function frozenGithub(pr: Snapshot) {
  const repo = `/repos/${pr.repo}`;
  const docs = Object.entries(pr.docs);
  const pull = {
    number: pr.number, title: pr.title, body: pr.body, state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean",
    user: { login: pr.author, type: "User" }, head: { sha: "eval", ref: "eval" }, base: { ref: "main" },
    additions: pr.files.reduce((sum, file) => sum + file.additions, 0), deletions: pr.files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: pr.files.length, labels: [], requested_reviewers: [], requested_teams: [], assignees: [],
  };
  return async function fetchFrozen(url: URL): Promise<Response> {
    const path = url.pathname;
    if (path === "/app") return Response.json({ slug: "triage-eval" });
    if (path === repo) return Response.json({ default_branch: "main", owner: { login: pr.repo.split("/")[0], type: "Organization" } });
    if (path === `${repo}/pulls`) return Response.json([pull]);
    if (path === `${repo}/pulls/${pr.number}`) return Response.json(pull);
    if (path === `${repo}/pulls/${pr.number}/commits`) return Response.json(pr.commits.map((message) => ({ commit: { message } })));
    if (path === `${repo}/pulls/${pr.number}/reviews` || path === `${repo}/issues/${pr.number}/comments`) return Response.json([]);
    if (path.startsWith(`${repo}/commits/`)) return Response.json({ check_runs: [] });
    if (path === `${repo}/pulls/${pr.number}/files`) {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json(pr.files.slice((page - 1) * perPage, page * perPage));
    }
    if (path.startsWith(`${repo}/git/trees/`)) {
      return Response.json({ sha: "tree", tree: docs.map(([doc, text], index) => ({ path: doc, type: "blob", sha: String(index), size: new TextEncoder().encode(text).byteLength })) });
    }
    const blob = path.startsWith(`${repo}/git/blobs/`) ? docs[Number(path.slice(`${repo}/git/blobs/`.length))] : undefined;
    return blob ? new Response(blob[1]) : new Response(null, { status: 404 });
  };
}

function pack(repo: string): CheckPack {
  return { ...emptyPack(repo), checks: { focused: { enabled: true }, docs: { enabled: true } } };
}

/** The mail the hub's bridge sends when a pull request opens, as stock hands it to the run. */
function triggerMail(pr: Snapshot) {
  const request = mailPayload(pr.repo, { ...DEFAULT_REPO_POLICY, enabled: true }, { pack: pack(pr.repo), automatic: [], source: { repo: { id: "eval", version: 1 } } }, { prNumber: pr.number, headSha: "eval", events: ["opened"] });
  return {
    headers: { from: `${TRIAGE_MAIL_SENDER}@${DOMAIN}`, to: [`${PR_TRIAGE_ADDRESS}@${DOMAIN}`] },
    rawHeaders: {},
    parts: [{ contentType: "text/plain", ref: "part-0", text: JSON.stringify(request) }],
  };
}

async function judge(input: CaseInput): Promise<Outcomes> {
  const pr = variant(snapshot(input.pull), input, input.mix === undefined ? undefined : snapshot(input.mix));
  const { verdict } = await runDefinition({ fetch: frozenGithub(pr), apiKey, endpoint: ENDPOINT, triggerPayload: triggerMail(pr) });
  const checks = Object.fromEntries(MODEL_CHECKS.map((check) => {
    const result = verdict.checks.find((row) => row.check === check)?.result;
    return [check, result === "pass" || result === "fail" ? result : "unsure"];
  }));
  return { ...checks, verdict: verdict.verdict } as Outcomes;
}

/** Right when the check answered what its label expects; the answer is the label, so unsure answers show apart. */
function answered(check: Scored): CheckFn<CaseInput, Outcomes, Expected> {
  return function right({ output, expect }) {
    const got = output[check];
    return { pass: got === expect![check], value: got === expect![check] ? 1 : 0, label: got };
  };
}

/** Wrong and unsure answers both miss; how many were unsure says how often the judge declined to decide, and each miss is named with its answer. */
function printUnsure(report: Report) {
  for (const check of SCORED) {
    const missed = report.cases.filter((row) => row.checks[check]?.pass === false).map((row) => `${row.name} (${row.checks[check]?.label})`);
    console.log(`  ${check}: ${report.cases.filter((row) => row.checks[check]?.label === "unsure").length} unsure${missed.length ? `; missed ${missed.join(", ")}` : ""}`);
  }
}

try {
  printUnsure(await evaluate("judge", {
    run: judge,
    cases: `${here}cases.jsonl`,
    checks: Object.fromEntries(SCORED.map((check) => [check, answered(check)])),
    // Focused decided every case in each measured run; two misses leave room for answers near the band edge. Docs missed 5
    // of the 49 cases, all unsure, in the first run after the tests check was removed. The verdict missed 2, none unsure, in its first run.
    allow: { docs: 7, focused: 2, verdict: 4 },
    about: { model: ENDPOINT.model },
    concurrency: 2,
    timeout: "10m",
  }));
} catch (error) {
  if (error instanceof EvalFailure) printUnsure(error.report);
  throw error;
}
