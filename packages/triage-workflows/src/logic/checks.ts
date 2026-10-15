import {
  catalogCheckEnabled,
  CLOSED_FINDING,
  classificationSources,
  customCheckEnabled,
  isTextCheck,
  parseCheckPack,
  NO_CHANGES_REQUESTED,
  NOT_A_DRAFT,
  repoPolicy,
  type AuthorKind,
  type CatalogId,
  type CheckOutput,
  type CheckPack,
  type IssueTracker,
  type TextCustomCheck,
  type TriageEvent,
  type TrustTier,
  type WorkflowState,
} from "@corbits/triage-contracts";
import { isRecord } from "@corbits/common";
import { globMatch } from "./glob.js";

export interface PrFileFacts {
  path: string;
  previousPath?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  /** Past the patch budget. */
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
  checks: "success" | "failure" | "pending" | "none";
  failingChecks: string[];
  pendingChecks: string[];
  reviewers: string[];
  approvals: number;
  changesRequested: string[];
  triageRequested: boolean;
  reviewAnswered: boolean;
  reviewedBy: string[];
  labels: string[];
  assignees: string[];
  changedFiles: number;
  additions: number;
  deletions: number;
  paths: string[];
  files: PrFileFacts[];
  body: string;
  commits: string[];
  /** In full, the first 100. */
  commitMessages: string[];
  docs: Record<string, string>;
  rules: Record<string, string>;
  branch: string;
  authorTeams: string[];
  /** Membership GitHub would not confirm either way. */
  authorTeamsUnknown: string[];
  /** Empty for webhook actions no pack event names. */
  events: TriageEvent[];
}

/** Requested changes the author has since pushed to or replied on, so they wait on the reviewer again. */
export const REVIEW_ANSWERED_REASON = "a reviewer requested changes; the author has responded";

export interface Finding {
  check: string;
  state: WorkflowState;
  reason: string;
}

export interface CheckResult {
  check: string;
  kind: "machine" | "model";
  result: "pass" | "fail" | "unconfirmed";
  reason: string;
  evidence: string[];
  output: CheckOutput;
}

export interface DeterministicResult {
  state: WorkflowState;
  reason: string;
  findings: Finding[];
  checks: CheckResult[];
  needsJudgment: boolean;
  sources?: ReturnType<typeof classificationSources>;
}

export const NEEDS_SETUP_REASON = "This repository still needs a policy.";

type CiRule = { status: string; reason: string; failed: boolean | null; names: (facts: PrFacts) => string[] };

// `none` is a head with no check runs at all (skipped or neutral runs complete as success), so the repository has no
// checks to wait for and the rule passes.
const CI_RULE: Record<PrFacts["checks"], CiRule> = {
  success: { status: "passing", reason: "required checks are passing", failed: false, names: () => [] },
  failure: { status: "failing", reason: "required checks are failing", failed: true, names: (facts) => facts.failingChecks },
  pending: { status: "pending", reason: "checks are still running", failed: null, names: (facts) => facts.pendingChecks },
  none: { status: "none", reason: "no checks configured", failed: false, names: () => [] },
};

const STATE_RANK: Record<WorkflowState, number> = {
  "ready-monitoring": 0,
  "awaiting-review": 1,
  "needs-author-update": 2,
  blocked: 3,
  "needs-decision": 4,
  "stale-unknown": 5,
};

function rankTop(findings: Finding[]): Finding | null {
  return findings.reduce<Finding | null>(
    (w, f) => (!w || STATE_RANK[f.state] > STATE_RANK[w.state] ? f : w),
    null,
  );
}

function finish(findings: Finding[], checks: CheckResult[], facts: PrFacts, pack?: CheckPack): DeterministicResult {
  const top = rankTop(findings);
  const sources = pack ? classificationSources(pack) : undefined;
  // A draft cannot be merged, so it is never ready.
  const parked = top === null && facts.state === "open" && facts.draft;
  const state = parked ? "awaiting-review" : top?.state ?? "ready-monitoring";
  return {
    state,
    reason: parked ? "pull request is a draft" : top?.reason ?? "all deterministic rules passed",
    findings,
    checks,
    needsJudgment: sources !== undefined && facts.state === "open" && !facts.draft && hardFailures(checks).length === 0,
    ...(sources ? { sources } : {}),
  };
}

type RuleOutcome = Pick<CheckResult, "check" | "kind" | "result">;

/** None on a draft, which is not decided at all. */
export function hardFailures<T extends RuleOutcome>(checks: readonly T[]): T[] {
  const failed = checks.filter((c) => c.kind === "machine" && c.result === "fail");
  return failed.some((c) => c.check === NOT_A_DRAFT) ? [] : failed;
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
  const text = [facts.title, facts.body, ...facts.commits].join("\n");
  if (tracker !== "linear") {
    const inText = GITHUB_ISSUE_REF.exec(text);
    if (inText) return inText[0].trim().replace(/^\(/, "");
    const inBranch = GITHUB_BRANCH_REF.exec(facts.branch);
    if (inBranch) return `#${inBranch[1]}`;
  }
  if (tracker !== "github") {
    const inText = LINEAR_ISSUE_REF.exec(text);
    if (inText) return inText[0];
    const inBranch = LINEAR_BRANCH_REF.exec(facts.branch);
    if (inBranch) return inBranch[1].toUpperCase();
  }
  return null;
}

const EXCERPT_MAX = 120;
const TEXT_EVIDENCE_MAX = 10;

function excerpt(text: string): string {
  const line = text.trim();
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX - 1)}…` : line;
}

type TextItem = { where: string; what: string; text: string };

function textItems(facts: PrFacts, rule: TextCustomCheck): TextItem[] {
  return rule.fields.flatMap(function items(field): TextItem[] {
    if (field === "title") return [{ where: "title", what: "the title", text: facts.title }];
    if (field === "description") return [{ where: "description", what: "the description", text: facts.body }];
    return facts.commitMessages.map((message) => ({ where: `commit "${excerpt(message.split("\n", 1)[0]!)}"`, what: "a commit message", text: message }));
  });
}

/** Each line of the item holding a phrase, as evidence quoting it. */
function phraseLines(item: TextItem, phrases: string[]): string[] {
  const lowered = phrases.map((phrase) => phrase.toLowerCase());
  return item.text.split("\n").filter((line) => lowered.some((phrase) => line.toLowerCase().includes(phrase))).map((line) => `${item.where}: ${excerpt(line)}`);
}

function quoted(phrases: string[]): string {
  return phrases.map((phrase) => `"${phrase}"`).join(", ");
}

/** Matched without regard to case; the evidence quotes each matching line, or names each item missing every phrase. */
function textResult(rule: TextCustomCheck, facts: PrFacts): { failed: boolean; reason: string; evidence: string[] } {
  const items = textItems(facts, rule);
  const phrases = quoted(rule.phrases);
  if (rule.failWhen === "contains") {
    const hits = items.filter((item) => phraseLines(item, rule.phrases).length > 0);
    const what = [...new Set(hits.map((item) => item.what))].join(" and ");
    return { failed: hits.length > 0, reason: hits.length ? `${what} contains ${phrases}` : `no ${phrases} found`, evidence: hits.flatMap((item) => phraseLines(item, rule.phrases)).slice(0, TEXT_EVIDENCE_MAX) };
  }
  const missing = items.filter((item) => phraseLines(item, rule.phrases).length === 0);
  const what = [...new Set(missing.map((item) => item.what))].join(" and ");
  return { failed: missing.length > 0, reason: missing.length ? `${what} does not contain ${phrases}` : `contains ${phrases}`, evidence: missing.map((item) => item.where).slice(0, TEXT_EVIDENCE_MAX) };
}

interface CheckRules {
  enabled(id: CatalogId): boolean;
  maxFiles?: number;
  maxLines?: number;
  forbiddenGlobs: string[];
  tracker: IssueTracker;
}

function evaluate(facts: PrFacts, rules: CheckRules, pack?: CheckPack): DeterministicResult {
  const findings: Finding[] = [];
  const checks: CheckResult[] = [];
  function add(check: string, state: WorkflowState, reason: string) {
    findings.push({ check, state, reason });
  }
  function result(check: CatalogId | typeof NOT_A_DRAFT | typeof NO_CHANGES_REQUESTED, failed: boolean | null, reason: string, evidence: string[], output: CheckOutput) {
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

  if (facts.state === "closed") add(CLOSED_FINDING, "ready-monitoring", "pull request is closed");
  else {
    result(NOT_A_DRAFT, facts.draft, facts.draft ? "pull request is a draft" : "pull request is not a draft", [], { kind: "values", values: { isDraft: facts.draft } });
    if (on("ci-green")) {
      const ci = CI_RULE[facts.checks];
      if (ci.failed === true) add("ci-green", "blocked", ci.reason);
      if (ci.failed === null) add("ci-green", "awaiting-review", ci.reason);
      result("ci-green", ci.failed, ci.reason, ci.names(facts), { kind: "values", values: { status: ci.status } });
    }
    if (on("no-merge-conflicts") && facts.mergeable === false) add("no-merge-conflicts", "blocked", "merge conflicts with base");
    const requested = facts.changesRequested;
    if (requested.length) add(NO_CHANGES_REQUESTED, "needs-author-update", "a reviewer requested changes");
    const requestedReason = facts.reviewAnswered ? REVIEW_ANSWERED_REASON : "a reviewer requested changes";
    result(NO_CHANGES_REQUESTED, requested.length > 0, requested.length ? requestedReason : "no changes requested", requested.map((login) => `changes requested by @${login}`), {
      kind: "values",
      values: { changesRequested: requested.length },
    });
    if (on("no-merge-conflicts") && !findings.length && facts.mergeable === null) add("no-merge-conflicts", "stale-unknown", "mergeability not yet computed");
    if (on("no-merge-conflicts")) {
      const conflicted = facts.mergeable === null ? null : !facts.mergeable;
      result("no-merge-conflicts", conflicted, conflicted === null ? "mergeability not yet computed" : conflicted ? "merge conflicts with base" : "no merge conflicts", [], {
        kind: "values",
        values: { hasConflicts: conflicted === true },
      });
    }
    if (on("max-files-changed")) {
      const changedFiles = facts.changedFiles;
      const over = rules.maxFiles !== undefined && changedFiles > rules.maxFiles;
      if (over) add("max-files-changed", "needs-author-update", `pull request touches ${changedFiles} files (max ${rules.maxFiles})`);
      result("max-files-changed", over, over ? "pull request is over the files limit" : "pull request is within the files limit", rules.maxFiles === undefined ? [] : [`${changedFiles} files (max ${rules.maxFiles})`], {
        kind: "values",
        values: { files: changedFiles },
      });
    }
    if (on("max-lines-changed")) {
      const lines = facts.additions + facts.deletions;
      const over = rules.maxLines !== undefined && lines > rules.maxLines;
      if (over) add("max-lines-changed", "needs-author-update", `pull request changes ${lines} lines (max ${rules.maxLines})`);
      result("max-lines-changed", over, over ? "pull request is over the lines limit" : "pull request is within the lines limit", rules.maxLines === undefined ? [] : [`${lines} lines changed (max ${rules.maxLines})`], {
        kind: "values",
        values: { lines },
      });
    }
    if (on("no-forbidden-paths") && rules.forbiddenGlobs.length > 0) {
      const matched = facts.paths.filter((path) => rules.forbiddenGlobs.some((glob) => globMatch(path, glob)));
      if (matched.length) add("no-forbidden-paths", "needs-author-update", "pull request touches a forbidden path");
      result("no-forbidden-paths", matched.length > 0, matched.length ? "pull request touches a forbidden path" : "no forbidden paths touched", matched, {
        kind: "values",
        values: { touchesForbiddenPaths: matched.length > 0 },
      });
    }
    if (on("linked-issue") && rules.tracker !== "off") {
      const ref = issueReference(facts, rules.tracker);
      if (!ref) add("linked-issue", "needs-author-update", "pull request does not reference an issue");
      result("linked-issue", ref === null, ref ? "references an issue" : "pull request does not reference an issue", ref ? [ref] : [], {
        kind: "values",
        values: { linkedIssue: ref !== null },
      });
    }
    for (const rule of pack?.custom.filter(isTextCheck).filter(customCheckEnabled) ?? []) {
      const { failed, reason, evidence } = textResult(rule, facts);
      if (failed) add(rule.id, "needs-author-update", reason);
      checks.push({ check: rule.id, kind: "machine", result: failed ? "fail" : "pass", reason, evidence, output: { kind: "values", values: { matched: failed } } });
    }
  }

  return finish(findings, checks, facts, pack);
}

function deriveFromPack(facts: PrFacts, pack: CheckPack): DeterministicResult {
  return evaluate(facts, {
    enabled: (id) => catalogCheckEnabled(pack, id),
    maxFiles: pack.checks["max-files-changed"]?.maxFiles,
    maxLines: pack.checks["max-lines-changed"]?.maxLines,
    forbiddenGlobs: pack.checks["no-forbidden-paths"]?.forbiddenGlobs ?? [],
    tracker: pack.checks["linked-issue"]?.tracker ?? "either",
  }, pack);
}

/** The hub read the stored policy, so what that read left out comes with the pack it mails. */
export function packFromInput(raw: unknown): CheckPack | null {
  const pack = parseCheckPack(raw);
  const dropped = isRecord(raw) && Array.isArray(raw.dropped) ? raw.dropped.filter((note): note is string => typeof note === "string") : [];
  return pack && dropped.length > 0 ? { ...pack, dropped: [...new Set([...(pack.dropped ?? []), ...dropped])] } : pack;
}

export function deriveState(facts: PrFacts, policy?: unknown, pack?: CheckPack | null): DeterministicResult {
  if (pack) return deriveFromPack(facts, pack);
  const legacy = repoPolicy(policy).checks;
  const enabled: Partial<Record<CatalogId, boolean>> = { "ci-green": legacy.ci, "no-merge-conflicts": legacy.conflicts };
  return evaluate(facts, {
    enabled: (id) => enabled[id] === true,
    forbiddenGlobs: [],
    tracker: "off",
  });
}
