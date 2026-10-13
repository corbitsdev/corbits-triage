// Preview: runs the real triage logic (deriveState, the quality questions,
// renderVerdict) on a repository's open pull requests, read live through `gh`,
// with the recommended check pack. Questions go to System One only when
// AI_GATEWAY_API_KEY (Vercel AI Gateway) or TYPESAFE_API_KEY is exported;
// otherwise items that need the decision model show as unavailable.
//
//   bun tooling/preview.ts [owner/repo]
import { evaluate } from "@corbits/system-one";
import { DEFAULT_REPO_POLICY, packMergeThreshold, recommendedPack } from "../packages/triage-contracts/src/index.js";
import { deriveState, type DeterministicResult, type PrFacts, type PrFileFacts } from "../packages/triage-workflows/src/logic/checks.js";
import type { Review } from "../packages/github-tool/src/github.js";
import { buildFacts, type CheckRun, type PrData } from "../packages/triage-workflows/src/logic/facts.js";
import { prepareQualityEvaluation, type QualityEvaluation } from "../packages/triage-workflows/src/logic/quality.js";
import { parseAnswers, renderVerdict, type RenderInput } from "../packages/triage-workflows/src/logic/render.js";

const repo = process.argv[2] ?? "corbitsdev/corbits-triage-sandbox";
const pack = recommendedPack(repo);

function gh<T>(path: string): T {
  const out = Bun.spawnSync(["gh", "api", "--paginate", "--slurp", path]);
  if (out.exitCode !== 0) throw new Error(`gh api ${path}: ${out.stderr.toString()}`);
  return (JSON.parse(out.stdout.toString()) as T[]).flat() as T;
}

function ghOne<T>(path: string): T {
  const out = Bun.spawnSync(["gh", "api", path]);
  if (out.exitCode !== 0) throw new Error(`gh api ${path}: ${out.stderr.toString()}`);
  return JSON.parse(out.stdout.toString()) as T;
}

function factsFor(n: number): PrFacts {
  const p = ghOne<any>(`repos/${repo}/pulls/${n}`);
  const pr: PrData = {
    title: p.title, body: p.body, author: p.user?.login, authorAssociation: p.author_association, sha: p.head?.sha, branch: p.head.ref, state: p.state, draft: p.draft,
    mergeable: p.mergeable,
    reviewers: [...(p.requested_reviewers ?? []).map((u: any) => u.login), ...(p.requested_teams ?? []).map((t: any) => t.slug)],
    additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files,
  };
  const checks = ghOne<{ check_runs: CheckRun[] }>(`repos/${repo}/commits/${p.head.sha}/check-runs`).check_runs;
  const reviews = gh<any[]>(`repos/${repo}/pulls/${n}/reviews`).map((r): Review => ({ reviewer: r.user?.login, state: r.state }));
  const files = gh<any[]>(`repos/${repo}/pulls/${n}/files`).map((row): PrFileFacts => ({
    path: String(row.filename),
    ...(typeof row.previous_filename === "string" ? { previousPath: row.previous_filename } : {}),
    ...(typeof row.status === "string" ? { status: row.status } : {}),
    ...(typeof row.additions === "number" ? { additions: row.additions } : {}),
    ...(typeof row.deletions === "number" ? { deletions: row.deletions } : {}),
    ...(typeof row.patch === "string" ? { patch: row.patch } : {}),
  }));
  const paths = files.map((file) => file.path);
  const commits = gh<any[]>(`repos/${repo}/pulls/${n}/commits`).map((c) => String(c.commit.message).split("\n", 1)[0]!);
  return { ...buildFacts(repo, n, pr, checks, reviews, [], DEFAULT_REPO_POLICY), paths, files, commits };
}

const endpoint = process.env.AI_GATEWAY_API_KEY ? { kind: "gateway" as const } : { kind: "official" as const };
const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.TYPESAFE_API_KEY);

export function previewEvaluation(facts: PrFacts, det: DeterministicResult) {
  return prepareQualityEvaluation(facts, det.sources);
}

export async function previewJudge(
  det: RenderInput["det"],
  evaluation: QualityEvaluation,
  evaluateQuality: typeof evaluate = evaluate,
  credentialAvailable = hasKey,
): Promise<Pick<RenderInput, "answers" | "judgeError" | "judgeLimitExceeded">> {
  if (!det.needsJudgment || !det.sources) return {};
  if (evaluation.judgeError) return { judgeError: evaluation.judgeError, judgeLimitExceeded: true };
  if (evaluation.requests.length === 0) return {};
  if (!credentialAvailable) return { judgeError: "no key exported" };
  const decisions: string[] = [];
  const errors: string[] = [];
  for (const { state, questions } of evaluation.requests) {
    const result = await evaluateQuality({ state, questions, config: { endpoint, timeoutMs: 30_000 } });
    if (result.fallback) errors.push(`${result.reason}${result.detail ? `: ${result.detail}` : ""}`);
    else decisions.push(...result.decisions.map((decision) => JSON.stringify(decision)));
  }
  return { answers: parseAnswers(decisions.join("")), ...(errors.length > 0 ? { judgeError: errors.join("; ") } : {}) };
}

if (import.meta.main) {
  const open = gh<Array<{ number: number }>>(`repos/${repo}/pulls?state=open&per_page=100`);
  const rows = [];
  for (const { number } of open.sort((a, b) => a.number - b.number)) {
    const facts = factsFor(number);
    const det = deriveState(facts, undefined, pack);
    const evaluation = previewEvaluation(facts, det);
    const v = renderVerdict({ author: facts.author, repo: facts.repo, headSha: facts.headSha, det, candidates: evaluation.candidates, plan: evaluation.plan, reviewers: facts.reviewers, threshold: packMergeThreshold(pack), ...(await previewJudge(det, evaluation)) });
    rows.push({
      pr: `#${number}`,
      title: facts.title.slice(0, 40),
      state: v.state,
      priority: v.priority,
      model: det.needsJudgment ? "asked" : "-",
      score: v.confidence === "unknown" ? "-" : v.confidence,
      failing: v.checks.filter((c) => c.result === "fail").map((c) => c.check).join(", "),
      next: `${v.actor}: ${v.nextAction}`,
      comment: v.feedback ? v.feedback.replaceAll("\n", " | ") : "none",
      degraded: v.degraded ?? "",
    });
  }
  console.table(rows);
}
