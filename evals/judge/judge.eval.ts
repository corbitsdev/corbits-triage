// Judge eval: replays frozen pull requests through the production triage steps (the hub's file paging, rules,
// one System One call per judge chunk, evaluate) against the production decision model and checks each model check's
// answer against its label. The judge is not deterministic, so each check may miss a few cases.
//
//   bun run eval:judge
import { EvalFailure, evaluate, type CheckFn, type Report } from "@corbits/evals";
import { evaluate as systemOne, type FallbackResult } from "@corbits/system-one";
import { readFileSync } from "node:fs";
import { readRepoDocsPage, repoDocs, type RepoDocsPage } from "../../packages/github-tool/src/github.js";
import { listFiles } from "../../apps/hub/src/github/pr-preview.js";
import { DEFAULT_REPO_POLICY, emptyPack, type CheckPack } from "../../packages/triage-contracts/src/index.js";
import { evaluate as evaluateStep } from "../../packages/triage-workflows/src/actions/evaluate.js";
import { rules, type JudgeChunk } from "../../packages/triage-workflows/src/actions/rules.js";
import { assembleItem, type RepoDocs } from "../../packages/triage-workflows/src/logic/facts.js";
import type { Verdict } from "../../packages/triage-workflows/src/logic/render.js";
import { MODEL_CHECKS, variant, type CaseInput, type Expected, type ModelCheck, type Snapshot, type StoredSnapshot } from "./cases.js";

// The OpenCode Zen preset the production workspace's decision model uses.
const ENDPOINT = { kind: "custom", url: "https://opencode.ai/zen/v1/systemone", model: "jev-1.13" } as const;
const RETRIES = 3;
const apiKey = process.env.OPENCODE_API_KEY;
if (!apiKey) throw new Error("OPENCODE_API_KEY is not set");

const here = new URL(".", import.meta.url).pathname;
const NO_EFFECTS: Parameters<typeof rules>[1] = {
  async perform() {
    throw new Error("the judge eval performs no effects");
  },
};

type Outcomes = Record<ModelCheck, "pass" | "fail" | "unsure">;

function snapshot(number: number): Snapshot {
  const stored = JSON.parse(readFileSync(`${here}pulls/${number}.json`, "utf8")) as StoredSnapshot;
  const docs = Object.fromEntries(Object.entries(stored.docs).map(([path, hash]) => [path, readFileSync(`${here}docs/${hash}.md`, "utf8")]));
  return { ...stored, docs };
}

/** Serves a snapshot as GitHub would: its paged file rows, and its docs as the default branch's tree and blobs. */
function frozenGithub(pr: Snapshot) {
  return async function fetchFrozen(path: string): Promise<Response> {
    const url = new URL(path, "https://api.github.com");
    const repo = `/repos/${pr.repo}`;
    if (url.pathname === `${repo}/pulls/${pr.number}/files`) {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      return Response.json(pr.files.slice((page - 1) * perPage, page * perPage));
    }
    const docs = Object.entries(pr.docs);
    if (url.pathname === repo) return Response.json({ default_branch: "main" });
    if (url.pathname.startsWith(`${repo}/git/trees/`)) {
      return Response.json({ sha: "tree", tree: docs.map(([doc, text], index) => ({ path: doc, type: "blob", sha: String(index), size: new TextEncoder().encode(text).byteLength })) });
    }
    const blob = url.pathname.startsWith(`${repo}/git/blobs/`) ? docs[Number(url.pathname.slice(`${repo}/git/blobs/`.length))] : undefined;
    return blob ? new Response(blob[1]) : new Response(null, { status: 404 });
  };
}

/** The docs as the facts director reads them, page by page. */
async function readDocs(gh: ReturnType<typeof frozenGithub>, repo: string): Promise<RepoDocs> {
  const pages: RepoDocsPage[] = [];
  let offset: number | undefined = 0;
  let ref: string | undefined;
  while (offset !== undefined) {
    const page = await readRepoDocsPage(gh, repo, { ref, offset });
    pages.push(page);
    ({ ref, next: offset } = page);
  }
  return repoDocs(pages);
}

function retryable(result: FallbackResult): boolean {
  return (result.reason === "timeout" || result.reason === "network" || (result.reason === "http-error" && (result.httpStatus === 429 || (result.httpStatus ?? 0) >= 500)));
}

/** One judge chunk answered as the judge director replies: the decisions as text, or the inference error. */
async function judgeChunk({ state, questions }: JudgeChunk): Promise<{ judge: string } | { judgeError: string }> {
  for (let attempt = 1; ; attempt++) {
    const result = await systemOne({ state, questions, config: { endpoint: ENDPOINT, timeoutMs: 120_000, apiKey } });
    if (!result.fallback) return { judge: result.decisions.map((decision) => JSON.stringify(decision)).join("\n") };
    if (!retryable(result) || attempt === RETRIES) return { judgeError: `${result.reason}${result.detail ? `: ${result.detail}` : ""}` };
    await Bun.sleep(2_000 * attempt);
  }
}

function pack(repo: string): CheckPack {
  return { ...emptyPack(repo), checks: { focused: { enabled: true }, docs: { enabled: true }, tests: { enabled: true } } };
}

async function judge(input: CaseInput): Promise<Outcomes> {
  const pr = variant(snapshot(input.pull), input, input.mix === undefined ? undefined : snapshot(input.mix));
  const gh = frozenGithub(pr);
  const files = await listFiles(gh, pr.repo, pr.number);
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const data = {
    pr: { title: pr.title, body: pr.body, author: pr.author, sha: "eval", branch: "eval", state: "open", mergeable: true, changedFiles: files.length, additions, deletions },
    checks: [],
    reviews: [],
    comments: [],
    commits: pr.commits.map((message) => ({ message })),
    files,
    authorTeams: null,
  };
  const item = assembleItem(pr.number, data, { repo: pr.repo, openPrs: [], policy: DEFAULT_REPO_POLICY, pack: pack(pr.repo), events: ["opened"], docs: await readDocs(gh, pr.repo) });
  const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, AbortSignal.timeout(1_000));
  const output = await Promise.all(ruled.chunks.map(judgeChunk));
  const verdict = await evaluateStep({ items: ruled.items, batch: false, judge: { output } }, NO_EFFECTS, AbortSignal.timeout(1_000)) as Verdict;
  return Object.fromEntries(MODEL_CHECKS.map((check) => {
    const result = verdict.checks.find((row) => row.check === check)?.result;
    return [check, result === "pass" || result === "fail" ? result : "unsure"];
  })) as Outcomes;
}

/** Right when the check answered what its label expects; the answer is the label, so unsure answers show apart. */
function answered(check: ModelCheck): CheckFn<CaseInput, Outcomes, Expected> {
  return function right({ output, expect }) {
    const got = output[check];
    return { pass: got === expect![check], value: got === expect![check] ? 1 : 0, label: got };
  };
}

/** Wrong and unsure answers both miss; how many were unsure says how often the judge declined to decide. */
function printUnsure(report: Report) {
  for (const check of MODEL_CHECKS) {
    console.log(`  ${check}: ${report.cases.filter((row) => row.checks[check]?.label === "unsure").length} unsure`);
  }
}

try {
  printUnsure(await evaluate("judge", {
    run: judge,
    cases: `${here}cases.jsonl`,
    checks: Object.fromEntries(MODEL_CHECKS.map((check) => [check, answered(check)])),
    // Main's code missed 10 docs cases, on the first 72 and on all 76.
    allow: { tests: 3, docs: 10, focused: 11 },
    about: { model: ENDPOINT.model },
    concurrency: 2,
    timeout: "10m",
  }));
} catch (error) {
  if (error instanceof EvalFailure) printUnsure(error.report);
  throw error;
}
