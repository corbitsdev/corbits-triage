import type { TriageState } from "@corbits/rule-packs";
import {
  catalogCheckEnabled,
  classificationSources,
  parseCheckPack,
  repoPolicy,
  type CheckPack,
  type IssueTracker,
} from "@corbits/triage-contracts";

export interface PrFacts {
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  state: "open" | "closed";
  draft: boolean;
  mergeable: boolean | null;
  baseBehindBy: number;
  checks: "success" | "failure" | "pending" | "none";
  requestedReviewers: number;
  approvals: number;
  openPrs: Array<{ number: number; title: string }>;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  paths?: string[];
  body?: string;
  commits?: string[];
}

export interface Finding {
  check: string;
  state: TriageState;
  reason: string;
}

export interface DeterministicResult {
  state: TriageState;
  reason: string;
  findings: Finding[];
  duplicateOf: number | null;
  needsJudgment: boolean;
  sources?: ReturnType<typeof classificationSources>;
}

export const DUPLICATE_THRESHOLD = 0.85;
export const DRIFT_THRESHOLD = 50;
export const NEEDS_SETUP_REASON = "This repository still needs check setup.";

const STATE_RANK: Record<TriageState, number> = {
  "ready-monitoring": 0,
  "awaiting-review": 1,
  "needs-author-update": 2,
  blocked: 3,
  "needs-decision": 4,
  "stale-unknown": 5,
};

function tokens(s: string) {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}

export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Only the later PR (higher number) is a duplicate of an earlier one; the earlier is never flagged. */
export function findDuplicate(facts: Pick<PrFacts, "number" | "title" | "openPrs">): { number: number; score: number } | null {
  let best: { number: number; score: number } | null = null;
  for (const other of facts.openPrs) {
    if (other.number >= facts.number) continue;
    const score = titleSimilarity(facts.title, other.title);
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) best = { number: other.number, score };
  }
  return best;
}

function globMatch(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function rankTop(findings: Finding[]): Finding | null {
  return findings.reduce<Finding | null>(
    (w, f) => (!w || STATE_RANK[f.state] > STATE_RANK[w.state] ? f : w),
    null,
  );
}

function finish(findings: Finding[], duplicateOf: number | null, facts: PrFacts, pack?: CheckPack): DeterministicResult {
  const top = rankTop(findings);
  const sources = pack ? classificationSources(pack) : undefined;
  const state = top?.state ?? "ready-monitoring";
  return {
    state,
    reason: top?.reason ?? "all deterministic checks passed",
    findings,
    duplicateOf,
    needsJudgment: facts.state === "open" && JUDGED_STATES.has(state) && hasModelChecks(sources),
    ...(sources ? { sources } : {}),
  };
}

const JUDGED_STATES = new Set<TriageState>(["ready-monitoring", "awaiting-review"]);

function hasModelChecks(sources: DeterministicResult["sources"]): boolean {
  return sources !== undefined && (sources.quality.length > 0 || sources.custom.length > 0);
}

const GITHUB_ISSUE_REF = /(^|[\s(])#\d+\b|github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/;
const LINEAR_ISSUE_REF = /\b[A-Z][A-Z0-9]+-\d+\b|linear\.app\/\S+\/issue\//;

export function referencesIssue(facts: Pick<PrFacts, "title" | "body" | "commits">, tracker: IssueTracker): boolean {
  const text = [facts.title, facts.body ?? "", ...(facts.commits ?? [])].join("\n");
  const github = GITHUB_ISSUE_REF.test(text);
  const linear = LINEAR_ISSUE_REF.test(text);
  if (tracker === "github") return github;
  if (tracker === "linear") return linear;
  return github || linear;
}

function deriveFromPack(facts: PrFacts, pack: CheckPack): DeterministicResult {
  const findings: Finding[] = [];
  function add(check: string, state: TriageState, reason: string) {
    findings.push({ check, state, reason });
  }
  function on(id: Parameters<typeof catalogCheckEnabled>[1]) {
    return catalogCheckEnabled(pack, id);
  }
  const dup = on("duplicate") ? findDuplicate(facts) : null;

  if (facts.state === "closed") add("state", "ready-monitoring", "pull request is closed");
  else {
    if (on("draft") && facts.draft) add("draft", "needs-author-update", "pull request is a draft");
    if (on("ci") && facts.checks === "failure") add("checks", "blocked", "required checks are failing");
    if (on("duplicate") && dup) add("duplicate", "needs-decision", `possible duplicate of #${dup.number}`);
    if (on("conflicts") && facts.mergeable === false) add("conflicts", "blocked", "merge conflicts with base");
    if (on("reviewers") && facts.requestedReviewers === 0 && facts.approvals === 0) add("reviewers", "awaiting-review", "no reviewers assigned");
    const maxBehindBy = pack.checks.drift?.maxBehindBy ?? DRIFT_THRESHOLD;
    if (on("drift") && facts.baseBehindBy >= maxBehindBy) add("drift", "needs-decision", `base has drifted ${facts.baseBehindBy} commits`);
    if (on("conflicts") && !findings.length && facts.mergeable === null) add("conflicts", "stale-unknown", "mergeability not yet computed");
    const maxFiles = pack.checks.size?.maxFiles;
    const maxLines = pack.checks.size?.maxLines;
    const changedFiles = facts.changedFiles ?? 0;
    const lines = (facts.additions ?? 0) + (facts.deletions ?? 0);
    if (on("size") && maxFiles !== undefined && changedFiles > maxFiles) {
      add("size", "needs-author-update", `pull request touches ${changedFiles} files (max ${maxFiles})`);
    }
    if (on("size") && maxLines !== undefined && lines > maxLines) {
      add("size", "needs-author-update", `pull request changes ${lines} lines (max ${maxLines})`);
    }
    const globs = pack.checks.paths?.forbiddenGlobs ?? [];
    const paths = facts.paths ?? [];
    if (on("paths") && globs.length > 0 && paths.some((path) => globs.some((glob) => globMatch(path, glob)))) {
      add("paths", "needs-author-update", "pull request touches a forbidden path");
    }
    const tracker = pack.checks.issue?.tracker ?? "either";
    if (on("issue") && tracker !== "off" && !referencesIssue(facts, tracker)) {
      add("issue", "needs-author-update", "pull request does not reference an issue");
    }
  }

  return finish(findings, dup?.number ?? null, facts, pack);
}

export function packFromInput(raw: unknown): CheckPack | null {
  return parseCheckPack(raw);
}

/** Leftover boolean flags when no pack is supplied. Pack, when present, is the check source. */
export function deriveState(facts: PrFacts, policy?: unknown, pack?: CheckPack | null): DeterministicResult {
  if (pack) return deriveFromPack(facts, pack);
  const enabled = repoPolicy(policy).checks;
  const findings: Finding[] = [];
  function add(check: string, state: TriageState, reason: string) {
    findings.push({ check, state, reason });
  }
  const dup = findDuplicate(facts);

  if (facts.state === "closed") add("state", "ready-monitoring", "pull request is closed");
  else {
    if (enabled.draft && facts.draft) add("draft", "needs-author-update", "pull request is a draft");
    if (enabled.ci && facts.checks === "failure") add("checks", "blocked", "required checks are failing");
    if (enabled.duplicate && dup) add("duplicate", "needs-decision", `possible duplicate of #${dup.number}`);
    if (enabled.conflicts && facts.mergeable === false) add("conflicts", "blocked", "merge conflicts with base");
    if (enabled.reviewers && facts.requestedReviewers === 0 && facts.approvals === 0) add("reviewers", "awaiting-review", "no reviewers assigned");
    if (enabled.drift && facts.baseBehindBy >= DRIFT_THRESHOLD) add("drift", "needs-decision", `base has drifted ${facts.baseBehindBy} commits`);
    if (enabled.conflicts && !findings.length && facts.mergeable === null) add("conflicts", "stale-unknown", "mergeability not yet computed");
  }

  return finish(findings, enabled.duplicate ? dup?.number ?? null : null, facts);
}
