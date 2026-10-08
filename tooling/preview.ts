// Preview: runs the real triage logic (deriveState, the quality questions,
// renderVerdict) on a repository's open pull requests, read live through `gh`,
// with the recommended check pack. Questions go to System One only when
// AI_GATEWAY_API_KEY (Vercel AI Gateway) or TYPESAFE_API_KEY is exported;
// otherwise items that need the decision model show as unavailable.
//
//   bun tooling/preview.ts [owner/repo]
import { evaluate } from "@corbits/system-one";
import { recommendedPack } from "../packages/triage-contracts/src/index.js";
import { deriveState, type PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { buildFacts, type CheckRun, type PrData, type Review } from "../packages/triage-workflows/src/logic/facts.js";
import { qualityQuestions, qualityState } from "../packages/triage-workflows/src/logic/quality.js";
import { renderVerdict, type RenderInput } from "../packages/triage-workflows/src/logic/render.js";

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
    title: p.title, body: p.body, author: p.user?.login, sha: p.head?.sha, branch: p.head.ref, state: p.state, draft: p.draft,
    mergeable: p.mergeable, requestedReviewers: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0),
    reviewers: [...(p.requested_reviewers ?? []).map((u: any) => u.login), ...(p.requested_teams ?? []).map((t: any) => t.slug)],
    additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files,
  };
  const checks = ghOne<{ check_runs: CheckRun[] }>(`repos/${repo}/commits/${p.head.sha}/check-runs`).check_runs;
  const reviews = gh<any[]>(`repos/${repo}/pulls/${n}/reviews`).map((r): Review => ({ reviewer: r.user?.login, state: r.state }));
  const paths = gh<any[]>(`repos/${repo}/pulls/${n}/files`).map((f) => String(f.filename));
  const commits = gh<any[]>(`repos/${repo}/pulls/${n}/commits`).map((c) => String(c.commit.message).split("\n", 1)[0]!);
  return { ...buildFacts(repo, n, pr, checks, reviews, openPrs), paths, commits };
}

const endpoint = process.env.AI_GATEWAY_API_KEY ? { kind: "gateway" as const } : { kind: "official" as const };
const hasKey = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.TYPESAFE_API_KEY);

async function judge(facts: PrFacts, det: RenderInput["det"]): Promise<Pick<RenderInput, "answers" | "judgeError">> {
  if (!det.needsJudgment || !det.sources) return {};
  if (!hasKey) return { judgeError: "no key exported" };
  const result = await evaluate({
    state: qualityState(facts),
    questions: qualityQuestions(det.sources),
    config: { endpoint, timeoutMs: 30_000 },
  });
  if (result.fallback) return { judgeError: `${result.reason}${result.detail ? `: ${result.detail}` : ""}` };
  const answers: Record<string, number> = {};
  for (const d of result.decisions) if (d.type === "noul") answers[d.id] = d.noul;
  return { answers };
}

const open = gh<Pull[]>(`repos/${repo}/pulls?state=open&per_page=100`).map(({ number, title }) => ({ number, title }));
const rows = [];
for (const { number } of open.sort((a, b) => a.number - b.number)) {
  const facts = factsFor(number, open);
  const det = deriveState(facts, undefined, pack);
  const v = renderVerdict({ author: facts.author, det, reviewers: facts.reviewers, ...(await judge(facts, det)) });
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
