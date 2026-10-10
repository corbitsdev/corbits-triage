// Preview: runs the real triage logic (deriveState, the quality questions,
// renderVerdict) on a repository's open pull requests, read live through `gh`,
// with the recommended check pack. Questions go to System One only when
// AI_GATEWAY_API_KEY (Vercel AI Gateway) or TYPESAFE_API_KEY is exported;
// otherwise items that need the decision model show as unavailable.
//
//   bun tooling/preview.ts [owner/repo]
import { evaluate } from "@corbits/system-one";
import { DEFAULT_REPO_POLICY, recommendedPack } from "../packages/triage-contracts/src/index.js";
import { deriveState, type DeterministicResult, type PrFacts, type PrFileFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { extractChangeCandidates, type ChangeCandidate } from "../packages/triage-workflows/src/logic/candidates.js";
import { buildFacts, type CheckRun, type PrData, type Review } from "../packages/triage-workflows/src/logic/facts.js";
import { qualityQuestions, qualityState } from "../packages/triage-workflows/src/logic/quality.js";
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

type Pull = { number: number; title: string };

function factsFor(n: number, openPrs: Pull[]): PrFacts {
  const p = ghOne<any>(`repos/${repo}/pulls/${n}`);
  const pr: PrData = {
    title: p.title, body: p.body, author: p.user?.login, authorAssociation: p.author_association, sha: p.head?.sha, branch: p.head.ref, state: p.state, draft: p.draft,
    mergeable: p.mergeable, requestedReviewers: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0),
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
  return { ...buildFacts(repo, n, pr, checks, reviews, openPrs, DEFAULT_REPO_POLICY), paths, files, commits };
}

const endpoint = process.env.AI_GATEWAY_API_KEY ? { kind: "gateway" as const } : { kind: "official" as const };
const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.TYPESAFE_API_KEY);

export function previewEvaluation(facts: PrFacts, det: DeterministicResult) {
  const candidates = extractChangeCandidates(facts.files);
  return {
    candidates,
    state: qualityState(facts, det.sources?.quality.some((source) => source.id === "focused") ? candidates : undefined),
    questions: det.sources ? qualityQuestions(det.sources, candidates) : [],
  };
}

async function judge(
  det: RenderInput["det"],
  evaluation: { candidates: ChangeCandidate[]; state: ReturnType<typeof qualityState>; questions: ReturnType<typeof qualityQuestions> },
): Promise<Pick<RenderInput, "answers" | "judgeError">> {
  if (!det.needsJudgment || !det.sources) return {};
  if (evaluation.questions.length === 0) return {};
  if (!hasKey) return { judgeError: "no key exported" };
  const result = await evaluate({
    state: evaluation.state,
    questions: evaluation.questions,
    config: { endpoint, timeoutMs: 30_000 },
  });
  if (result.fallback) return { judgeError: `${result.reason}${result.detail ? `: ${result.detail}` : ""}` };
  return { answers: parseAnswers(result.decisions.map((decision) => JSON.stringify(decision)).join("")) };
}

if (import.meta.main) {
  const open = gh<Pull[]>(`repos/${repo}/pulls?state=open&per_page=100`).map(({ number, title }) => ({ number, title }));
  const rows = [];
  for (const { number } of open.sort((a, b) => a.number - b.number)) {
    const facts = factsFor(number, open);
    const det = deriveState(facts, undefined, pack);
    const evaluation = previewEvaluation(facts, det);
    const v = renderVerdict({ author: facts.author, det, candidates: evaluation.candidates, reviewers: facts.reviewers, ...(await judge(det, evaluation)) });
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
