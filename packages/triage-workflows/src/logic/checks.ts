import type { TriageState } from "@corbits/rule-packs";
import {
  catalogCheckEnabled,
  classificationSources,
  parseCheckPack,
  repoPolicy,
  type AuthorKind,
  type CatalogId,
  type CheckOutput,
  type CheckPack,
  type IssueTracker,
  type RepoRole,
  type TriageEvent,
  type TrustTier,
} from "@corbits/triage-contracts";
import { globMatch } from "./glob.js";
import { evaluateRuleChecks } from "./rule-checks.js";

export interface PrFileFacts {
  path: string;
  previousPath?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  /** The patch was read only in part, past the patch budget, so its later hunks are missing. */
  patchTruncated?: true;
}

export interface PrFacts {
  repo: string;
  number: number;
  title: string;
  author: string;
  authorKind?: AuthorKind;
  tier: TrustTier;
  headSha: string;
  state: "open" | "closed";
  draft: boolean;
  mergeable: boolean | null;
  baseBehindBy: number;
  checks: "success" | "failure" | "pending" | "none";
  failingChecks?: string[];
  requestedReviewers: number;
  reviewers?: string[];
  approvals: number;
  changesRequested?: string[];
  /** The author pushed, commented or replied in a review after the newest standing request for changes. */
  reviewAnswered?: boolean;
  /** Logins whose latest review stands on the current head. */
  reviewedBy?: string[];
  labels?: string[];
  assignees?: string[];
  openPrs: Array<{ number: number; title: string }>;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  paths?: string[];
  files?: PrFileFacts[];
  body?: string;
  commits?: string[];
  /** The repository's docs on the default branch, by path. */
  docs?: Record<string, string>;
  /** The repository's contribution rules on the default branch, by path, read apart from its docs. */
  rules?: Record<string, string>;
  branch?: string;
  /** Teams the pack's roles name that the author is an active member of, as the roles write them. */
  authorTeams?: string[];
  /** Teams the pack's roles name whose membership GitHub would not confirm either way. */
  authorTeamsUnknown?: string[];
  /** What woke this run; empty for webhook actions no pack event names. */
  events?: TriageEvent[];
}

/** Requested changes the author has since pushed to or replied on, so they wait on the reviewer again. */
export const REVIEW_ANSWERED_REASON = "a reviewer requested changes; the author has responded";

export interface Finding {
  check: string;
  state: TriageState;
  reason: string;
}

export interface CheckResult {
  check: string;
  kind: "machine" | "model";
  result: "pass" | "fail" | "unconfirmed";
  reason: string;
  evidence: string[];
  output: CheckOutput;
  /** Decides an action's branch without being a defect: never a step, a comment line, a merge reason or a retry. */
  gate?: true;
}

export interface DeterministicResult {
  state: TriageState;
  reason: string;
  findings: Finding[];
  checks: CheckResult[];
  duplicateOf: number | null;
  needsJudgment: boolean;
  sources?: ReturnType<typeof classificationSources>;
}

export const DUPLICATE_THRESHOLD = 0.85;
export const DRIFT_THRESHOLD = 50;
export const NEEDS_SETUP_REASON = "This repository still needs check setup.";

const CI_STATUS: Record<PrFacts["checks"], string> = { success: "passing", failure: "failing", pending: "pending", none: "none" };

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

function rankTop(findings: Finding[]): Finding | null {
  return findings.reduce<Finding | null>(
    (w, f) => (!w || STATE_RANK[f.state] > STATE_RANK[w.state] ? f : w),
    null,
  );
}

function finish(findings: Finding[], checks: CheckResult[], duplicateOf: number | null, facts: PrFacts, pack?: CheckPack): DeterministicResult {
  const top = rankTop(findings);
  const sources = pack ? classificationSources(pack) : undefined;
  // A draft cannot be merged, so it is never ready.
  const parked = top === null && facts.state === "open" && facts.draft;
  const state = parked ? "awaiting-review" : top?.state ?? "ready-monitoring";
  return {
    state,
    reason: parked ? "pull request is a draft" : top?.reason ?? "all deterministic checks passed",
    findings,
    checks,
    duplicateOf,
    needsJudgment: facts.state === "open" && state !== "stale-unknown" && hasModelChecks(sources),
    ...(sources ? { sources } : {}),
  };
}

export function hasModelChecks(sources: DeterministicResult["sources"]): boolean {
  return sources !== undefined && (sources.quality.length > 0 || sources.custom.length > 0);
}

const GITHUB_ISSUE_REF = /(^|[\s(])#\d+\b|github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/;
const LINEAR_ISSUE_REF = /\b[A-Z][A-Z0-9]+-\d+\b|linear\.app\/\S+\/issue\//;
// GitHub's "create a branch" names branches `123-title`; Linear's are `cl-123-title`.
const GITHUB_BRANCH_REF = /^(\d+)-/;
const LINEAR_BRANCH_REF = /\b([a-z][a-z0-9]+-\d+)\b/i;

export function issueReference(facts: Pick<PrFacts, "title" | "body" | "commits" | "branch">, tracker: IssueTracker): string | null {
  const text = [facts.title, facts.body ?? "", ...(facts.commits ?? [])].join("\n");
  if (tracker !== "linear") {
    const inText = GITHUB_ISSUE_REF.exec(text);
    if (inText) return inText[0].trim().replace(/^\(/, "");
    const inBranch = facts.branch === undefined ? null : GITHUB_BRANCH_REF.exec(facts.branch);
    if (inBranch) return `#${inBranch[1]}`;
  }
  if (tracker !== "github") {
    const inText = LINEAR_ISSUE_REF.exec(text);
    if (inText) return inText[0];
    const inBranch = facts.branch === undefined ? null : LINEAR_BRANCH_REF.exec(facts.branch);
    if (inBranch) return inBranch[1].toUpperCase();
  }
  return null;
}

interface CheckRules {
  enabled(id: CatalogId): boolean;
  maxBehindBy: number;
  maxFiles?: number;
  maxLines?: number;
  forbiddenGlobs: string[];
  tracker: IssueTracker;
}

function evaluate(facts: PrFacts, rules: CheckRules, pack?: CheckPack, roles: Record<string, RepoRole> = {}): DeterministicResult {
  const findings: Finding[] = [];
  const checks: CheckResult[] = [];
  function add(check: string, state: TriageState, reason: string) {
    findings.push({ check, state, reason });
  }
  function result(check: CatalogId | "review", failed: boolean | null, reason: string, evidence: string[], output: CheckOutput) {
    checks.push({
      check,
      kind: "machine",
      result: failed === null ? "unconfirmed" : failed ? "fail" : "pass",
      reason,
      evidence,
      output: failed === null ? { kind: "could-not-check", reason } : output,
    });
  }
  const on = rules.enabled;
  const dup = on("duplicate") ? findDuplicate(facts) : null;

  if (facts.state === "closed") add("state", "ready-monitoring", "pull request is closed");
  else {
    if (on("draft")) {
      result("draft", facts.draft, facts.draft ? "pull request is a draft" : "pull request is not a draft", [], { kind: "values", values: { isDraft: facts.draft } });
    }
    if (on("ci")) {
      const failing = facts.checks === "failure";
      if (failing) add("checks", "blocked", "required checks are failing");
      result("ci", failing, failing ? "required checks are failing" : `checks are ${facts.checks}`, failing ? facts.failingChecks ?? [] : [], { kind: "values", values: { status: CI_STATUS[facts.checks] } });
    }
    if (on("duplicate")) {
      if (dup) add("duplicate", "needs-decision", `possible duplicate of #${dup.number}`);
      result("duplicate", dup !== null, dup ? "possible duplicate" : "no duplicate found", dup ? [`#${dup.number}`] : [], { kind: "values", values: dup ? { isDuplicate: true, duplicateOf: dup.number } : { isDuplicate: false } });
    }
    if (on("conflicts") && facts.mergeable === false) add("conflicts", "blocked", "merge conflicts with base");
    const unreviewed = facts.requestedReviewers === 0 && facts.approvals === 0;
    if (on("reviewers")) {
      if (unreviewed) add("reviewers", "awaiting-review", "no reviewers assigned");
      result("reviewers", unreviewed, unreviewed ? "no reviewers assigned" : "reviewers assigned", [`${facts.requestedReviewers} requested, ${facts.approvals} approved`], {
        kind: "values",
        values: { requested: facts.requestedReviewers, approvals: facts.approvals },
      });
    }
    const drifted = facts.baseBehindBy >= rules.maxBehindBy;
    if (on("drift")) {
      if (drifted) add("drift", "needs-decision", `base has drifted ${facts.baseBehindBy} commits`);
      result("drift", drifted, drifted ? "base has drifted" : "base is current", [`${facts.baseBehindBy} commits behind (max ${rules.maxBehindBy})`], {
        kind: "values",
        values: { behindBy: facts.baseBehindBy },
      });
    }
    const requested = facts.changesRequested ?? [];
    if (requested.length) add("review", "needs-author-update", "a reviewer requested changes");
    const requestedReason = facts.reviewAnswered === true ? REVIEW_ANSWERED_REASON : "a reviewer requested changes";
    result("review", requested.length > 0, requested.length ? requestedReason : "no changes requested", requested.map((login) => `changes requested by @${login}`), {
      kind: "values",
      values: { changesRequested: requested.length },
    });
    if (on("conflicts") && !findings.length && facts.mergeable === null) add("conflicts", "stale-unknown", "mergeability not yet computed");
    if (on("conflicts")) {
      const conflicted = facts.mergeable === null ? null : !facts.mergeable;
      result("conflicts", conflicted, conflicted === null ? "mergeability not yet computed" : conflicted ? "merge conflicts with base" : "no merge conflicts", [], {
        kind: "values",
        values: { hasConflicts: conflicted === true },
      });
    }
    if (on("size")) {
      const changedFiles = facts.changedFiles ?? 0;
      const lines = (facts.additions ?? 0) + (facts.deletions ?? 0);
      const files = { over: rules.maxFiles !== undefined && changedFiles > rules.maxFiles, text: `${changedFiles} files (max ${rules.maxFiles})` };
      const size = { over: rules.maxLines !== undefined && lines > rules.maxLines, text: `${lines} lines changed (max ${rules.maxLines})` };
      if (files.over) add("size", "needs-author-update", `pull request touches ${changedFiles} files (max ${rules.maxFiles})`);
      if (size.over) add("size", "needs-author-update", `pull request changes ${lines} lines (max ${rules.maxLines})`);
      const measured = [...(rules.maxFiles !== undefined ? [files] : []), ...(rules.maxLines !== undefined ? [size] : [])];
      const over = measured.filter((m) => m.over);
      result("size", over.length > 0, over.length ? "pull request is over the size limits" : "pull request is within the size limits", (over.length ? over : measured).map((m) => m.text), {
        kind: "values",
        values: { files: changedFiles, lines },
      });
    }
    if (on("paths") && rules.forbiddenGlobs.length > 0) {
      const matched = (facts.paths ?? []).filter((path) => rules.forbiddenGlobs.some((glob) => globMatch(path, glob)));
      if (matched.length) add("paths", "needs-author-update", "pull request touches a forbidden path");
      result("paths", matched.length > 0, matched.length ? "pull request touches a forbidden path" : "no forbidden paths touched", matched, {
        kind: "values",
        values: { touchesForbiddenPaths: matched.length > 0 },
      });
    }
    if (on("issue") && rules.tracker !== "off") {
      const ref = issueReference(facts, rules.tracker);
      if (!ref) add("issue", "needs-author-update", "pull request does not reference an issue");
      result("issue", ref === null, ref ? "references an issue" : "pull request does not reference an issue", ref ? [ref] : [], {
        kind: "values",
        values: { linkedIssue: ref !== null },
      });
    }
    if (pack) {
      const custom = evaluateRuleChecks(facts, classificationSources(pack).rules, roles);
      findings.push(...custom.findings);
      checks.push(...custom.checks);
    }
  }

  return finish(findings, checks, dup?.number ?? null, facts, pack);
}

function deriveFromPack(facts: PrFacts, pack: CheckPack, roles: Record<string, RepoRole>): DeterministicResult {
  return evaluate(facts, {
    enabled: (id) => catalogCheckEnabled(pack, id),
    maxBehindBy: pack.checks.drift?.maxBehindBy ?? DRIFT_THRESHOLD,
    maxFiles: pack.checks.size?.maxFiles,
    maxLines: pack.checks.size?.maxLines,
    forbiddenGlobs: pack.checks.paths?.forbiddenGlobs ?? [],
    tracker: pack.checks.issue?.tracker ?? "either",
  }, pack, roles);
}

export function packFromInput(raw: unknown): CheckPack | null {
  return parseCheckPack(raw);
}

/** Leftover boolean flags when no pack is supplied. Pack, when present, is the check source. */
export function deriveState(facts: PrFacts, policy?: unknown, pack?: CheckPack | null, roles: Record<string, RepoRole> = {}): DeterministicResult {
  if (pack) return deriveFromPack(facts, pack, roles);
  const enabled: Partial<Record<CatalogId, boolean>> = repoPolicy(policy).checks;
  return evaluate(facts, {
    enabled: (id) => enabled[id] === true,
    maxBehindBy: DRIFT_THRESHOLD,
    forbiddenGlobs: [],
    tracker: "off",
  });
}
