import {
  askRules,
  AUTHOR_GROUPS,
  catalogCheckEnabled,
  CLOSED_FINDING,
  classificationSources,
  CONVENTIONAL_FIELDS,
  CONVENTIONAL_TYPES,
  DEFAULT_RISK,
  DEFAULT_MARKS,
  DEFAULT_RISK_LEVELS,
  DEFAULT_SENSITIVE,
  customCheckEnabled,
  hardFailures,
  ISSUE_LINKS,
  isGeneratedPath,
  isPatternsCheck,
  isTextCheck,
  labelRules,
  levelLabel,
  NO_CHANGES_REQUESTED,
  NOT_A_DRAFT,
  readCheckPack,
  RECOMMENDED_SIZE,
  repoPolicy,
  SIZE_RULES,
  type AuthorKind,
  type CatalogId,
  type CheckOutput,
  type CheckPack,
  type ConventionalField,
  type IssueTracker,
  type RiskLevels,
  type RiskSignal,
  type SensitiveGroup,
  type SizeRuleId,
  type TextCustomCheck,
  type TriageEvent,
  type TrustTier,
  type WorkflowState,
} from "@corbits/triage-contracts";
import { isRecord } from "@corbits/common";
import type { Stack } from "@corbits/github-reads";
import { globMatch } from "./glob.js";
import { duplicateResult, type OpenPulls } from "./duplicates.js";
import type { PatternsResult } from "./patterns.js";
import { hotFiles, matchingPaths, riskLevel, riskOutcome, sensitiveHits, sensitiveLevel, untested, type SensitiveHit } from "./risk.js";

export interface PrFileFacts {
  path: string;
  /** The host's path, when it differs from the shown `path`; reads use it. */
  hostPath?: string;
  previousPath?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  /** Listed past the code rules' patch ceiling, so its patch was not read. */
  patchUnread?: true;
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
  checks: "success" | "failure" | "pending" | "cancelled" | "none";
  failingChecks: string[];
  pendingChecks: string[];
  cancelledChecks: string[];
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
  /** The description as written, with the comments and link addresses a reader does not see. */
  rawBody: string;
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
  /** Set only on a stacked branch: the pull requests merged into it, and the open one it is based on. */
  stack?: Stack;
  /** What the title, description, commits and paths hid, as `where: what`, never the hidden text. */
  hidden: string[];
  /** Set only when regression risk or risk is on: the fix commits in each changed file's recent history, by path, or null when that history could not be read in full. */
  fixes?: Record<string, number | null>;
  /** Each code-patterns rule's matches on the added lines, by rule id; matched where the files were read. */
  patterns?: Record<string, PatternsResult>;
  /** Set only when a duplicate rule is on: the other open pull requests on the same base branch, or why they were not read. */
  openPulls?: OpenPulls;
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
  /** Set on a rule whose failure is asked of a maintainer, leaving the verdict Unsure instead of Fail. */
  onFail?: "ask";
  /** The evidence lines naming files the rule skipped rather than checked. */
  skipped?: string[];
  /** The label a rule that did not fail still adds: sensitive paths or risk below its `failAt` and at or above its `labelAt`. */
  label?: string;
}

export interface DeterministicResult {
  state: WorkflowState;
  reason: string;
  findings: Finding[];
  checks: CheckResult[];
  needsJudgment: boolean;
  sources?: ReturnType<typeof classificationSources>;
  /** The policy's labelling rules, which never decide the verdict, and the results of those read without the model; `checks` holds neither. */
  labelled?: { ids: string[]; checks: CheckResult[] };
  /** The policy's rules whose failure is asked of a maintainer. */
  ask?: string[];
}

export const NEEDS_SETUP_REASON = "This repository still needs a policy.";
/** The hub read the policy but this deployment cannot, so the run stays unsettled and is retried once the deployment catches up. */
export const DEPLOYMENT_UNREADABLE = "This Triage deployment can't read the policy: ";

type CiRule = { status: string; reason: string; failed: boolean | null; names: (facts: PrFacts) => string[] };

// `none` is a head with no check runs at all (skipped or neutral runs complete as success), so the repository has no
// checks to wait for and the rule passes.
const CI_RULE: Record<PrFacts["checks"], CiRule> = {
  success: { status: "passing", reason: "required checks are passing", failed: false, names: () => [] },
  failure: { status: "failing", reason: "required checks are failing", failed: true, names: (facts) => facts.failingChecks },
  pending: { status: "pending", reason: "checks are still running", failed: null, names: (facts) => facts.pendingChecks },
  cancelled: { status: "cancelled", reason: "checks were cancelled and need a re-run", failed: null, names: (facts) => facts.cancelledChecks },
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

function finish(all: Finding[], results: CheckResult[], facts: PrFacts, pack?: CheckPack): DeterministicResult {
  const ids = pack ? [...labelRules(pack).keys()] : [];
  const ask = pack ? askRules(pack) : [];
  const findings = all.filter((f) => !ids.includes(f.check) && !ask.includes(f.check));
  const checks = results.filter((c) => !ids.includes(c.check)).map((c) => forMaintainer(c, ask));
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
    ...(ids.length > 0 && { labelled: { ids, checks: results.filter((c) => ids.includes(c.check)) } }),
    ...(ask.length > 0 && { ask }),
  };
}

export function forMaintainer(c: CheckResult, ask: readonly string[] | undefined): CheckResult {
  return ask?.includes(c.check) ? { ...c, onFail: "ask" } : c;
}

/** The host diffs a pull request against its base branch, so one based on another's branch shows only its own changes; one with pull requests merged into its branch holds theirs too. */
export function holdsOthersChanges(stack: Stack | undefined): boolean {
  return stack !== undefined && stack.includes.length > 0;
}

export function hasModelChecks(sources: DeterministicResult["sources"]): boolean {
  return sources !== undefined && (sources.quality.length > 0 || sources.custom.length > 0);
}

const GITHUB_ISSUE_REF = new RegExp(`(^|[\\s(])#\\d+\\b|${ISSUE_LINKS.github.source}`);
const LINEAR_ISSUE_REF = new RegExp(`\\b[A-Z][A-Z0-9]+-\\d+\\b|${ISSUE_LINKS.linear.source}`);
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

/** `written` marks the description as written, beside the one a reader is shown. */
type TextItem = { where: string; what: string; text: string; phrases: string[]; written?: boolean };

/** The raw description answers only for the phrases the shown one lacks, so a visible phrase is quoted once. */
function descriptionItems(facts: PrFacts, rule: TextCustomCheck): TextItem[] {
  const shown = { where: "description", what: "the description", text: facts.body, phrases: rule.phrases };
  if (rule.failWhen === "not-contains") return [shown];
  const unseen = rule.phrases.filter((phrase) => phraseLines({ ...shown, phrases: [phrase] }).length === 0);
  return [shown, { ...shown, text: facts.rawBody, phrases: unseen, written: true }];
}

function textItems(facts: PrFacts, rule: TextCustomCheck): TextItem[] {
  return rule.fields.flatMap(function items(field): TextItem[] {
    if (field === "title") return [{ where: "title", what: "the title", text: facts.title, phrases: rule.phrases }];
    if (field === "description") return descriptionItems(facts, rule);
    return facts.commitMessages.map((message) => ({ where: `commit "${excerpt(message.split("\n", 1)[0]!)}"`, what: "a commit message", text: message, phrases: rule.phrases }));
  });
}

type TextMatch = { where: string; what: string; line: string; phrases: string[]; written?: boolean };

/** Each line of the item holding a phrase, with the phrases it holds. */
function textMatches(item: TextItem): TextMatch[] {
  return item.text.split("\n").flatMap(function matched(line): TextMatch[] {
    const phrases = item.phrases.filter((phrase) => line.toLowerCase().includes(phrase.toLowerCase()));
    return phrases.length ? [{ where: item.where, what: item.what, line, phrases, written: item.written }] : [];
  });
}

function quotedLine(match: TextMatch): string {
  return `${match.where}: ${excerpt(match.line)}`;
}

/** Each line of the item holding a phrase, as evidence quoting it. */
function phraseLines(item: TextItem): string[] {
  return textMatches(item).map(quotedLine);
}

function withoutLinkTargets(line: string): string {
  return line.replace(/\]\([^)]*\)/g, "");
}

/** A written line and a shown line with the same key read the same: the same letters and digits outside link targets. */
function lineKey(line: string): string {
  return withoutLinkTargets(line).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

/** The written copy of a quoted shown line, holding no phrase a reader cannot see on it. */
function shownCopy(match: TextMatch, all: TextMatch[]): boolean {
  if (!match.written) return false;
  const visible = withoutLinkTargets(match.line).toLowerCase();
  if (!match.phrases.every((phrase) => visible.includes(phrase.toLowerCase()))) return false;
  return all.some((other) => !other.written && other.where === match.where && lineKey(other.line) === lineKey(match.line));
}

function placeReason(what: string, hits: TextMatch[], rule: TextCustomCheck): string {
  const found = rule.phrases.filter((phrase) => hits.some((hit) => hit.what === what && hit.phrases.includes(phrase)));
  return `${what} contains ${quoted(found)}`;
}

function quoted(phrases: string[]): string {
  return phrases.map((phrase) => `"${phrase}"`).join(", ");
}

/** Matched without regard to case; the evidence quotes each matching line, or names each item missing every phrase. */
function textResult(rule: TextCustomCheck, facts: PrFacts): { failed: boolean; reason: string; evidence: string[] } {
  const items = textItems(facts, rule);
  const phrases = quoted(rule.phrases);
  if (rule.failWhen === "contains") {
    const all = items.flatMap(textMatches);
    const hits = all.filter((match) => !shownCopy(match, all));
    const places = [...new Set(hits.map((hit) => hit.what))];
    const one = places.length === 1 && new Set(hits.flatMap((hit) => hit.phrases)).size === 1;
    const reason = `${places.map((what) => placeReason(what, hits, rule)).join("; ")}; remove ${one ? "it" : "them"}`;
    return { failed: hits.length > 0, reason: hits.length ? reason : `no ${phrases} found`, evidence: hits.map(quotedLine).slice(0, TEXT_EVIDENCE_MAX) };
  }
  const missing = items.filter((item) => phraseLines(item).length === 0);
  const what = [...new Set(missing.map((item) => item.what))].join(" and ");
  return { failed: missing.length > 0, reason: missing.length ? `${what} does not contain ${phrases}` : `contains ${phrases}`, evidence: missing.map((item) => item.where).slice(0, TEXT_EVIDENCE_MAX) };
}

// `type(scope)!: subject`; the type is checked against the policy's list once it parses, ignoring case as the spec asks.
const CONVENTIONAL_SUBJECT = /^([^\s():!]+)(?:\([^()]+\))?!?: \S/;
// Subjects git and the hosts write themselves: merges, and the revert button's `Revert "…"`.
const GENERATED_SUBJECT = /^(?:Merge (?:pull request|branch|remote-tracking branch|commit|tag) |Revert ")/;
const OFFENDERS_SHOWN = 3;

type ConventionalRule = { types: readonly string[]; fields: readonly ConventionalField[] };

function isConventional(subject: string, types: readonly string[]): boolean {
  const type = CONVENTIONAL_SUBJECT.exec(subject)?.[1]?.toLowerCase();
  return type !== undefined && types.some((allowed) => allowed.toLowerCase() === type);
}

function offenderReason(subject: string): string {
  return `\`${excerpt(subject).replaceAll("`", "'")}\` isn't a conventional commit`;
}

/** Each title or commit subject that is not `type(scope)!: subject` with an allowed type; merges and reverts are left out. */
function conventionalResult(facts: PrFacts, { types, fields }: ConventionalRule): { failed: boolean; reason: string } {
  const commits = facts.commitMessages.map((message) => message.split("\n", 1)[0]!);
  const subjects = [...(fields.includes("title") ? [facts.title] : []), ...(fields.includes("commits") ? commits : [])].map((subject) => subject.trim());
  const offenders = [...new Set(subjects.filter((subject) => !GENERATED_SUBJECT.test(subject) && !isConventional(subject, types)))];
  if (offenders.length === 0) return { failed: false, reason: "follows conventional commits" };
  const shown = offenders.slice(0, OFFENDERS_SHOWN).map(offenderReason);
  const more = offenders.length - shown.length;
  return { failed: true, reason: [...shown, ...(more > 0 ? [`and ${more} more`] : [])].join("; ") };
}

type SizeLimits = Partial<Record<SizeRuleId, number>>;
type SizeTotal = Exclude<SizeRuleId, "max-lines-changed-per-file">;
type SizeResult = { id: SizeRuleId; finding?: string; reason: string; evidence: string[]; values: Record<string, number> };

const SIZE_WORDS: Record<SizeTotal, { key: string; verb: string; noun: string; counted: string }> = {
  "max-files-changed": { key: "files", verb: "touches", noun: "files", counted: "files" },
  "max-lines-changed": { key: "lines", verb: "changes", noun: "lines", counted: "lines changed" },
  "max-additions": { key: "additions", verb: "adds", noun: "lines", counted: "lines added" },
  "max-deletions": { key: "deletions", verb: "deletes", noun: "lines", counted: "lines deleted" },
};

function lineCount(files: readonly PrFileFacts[], key: "additions" | "deletions"): number {
  return files.reduce((total, file) => total + (file[key] ?? 0), 0);
}

function fileLines(file: PrFileFacts): number {
  return (file.additions ?? 0) + (file.deletions ?? 0);
}

function perFileResult(files: readonly PrFileFacts[], max: number | undefined): SizeResult {
  const id = "max-lines-changed-per-file";
  const over = max === undefined ? [] : files.filter((file) => fileLines(file) > max).sort((a, b) => fileLines(b) - fileLines(a));
  const values = { lines: Math.max(0, ...files.map(fileLines)) };
  if (over.length === 0) return { id, reason: "every file is within the per-file lines limit", evidence: [], values };
  const shown = over.slice(0, OFFENDERS_SHOWN).map((file) => `${file.path}: ${fileLines(file)} lines changed (max ${max})`);
  const more = over.length - shown.length;
  return {
    id,
    finding: `pull request changes ${values.lines} lines in ${over[0]!.path} (max ${max})`,
    reason: "a file is over the per-file lines limit",
    evidence: [...shown, ...(more > 0 ? [`and ${more} more`] : [])],
    values,
  };
}

/** Each size rule's result; generated files, such as lockfiles, are left out of every count. */
function sizeResults(facts: PrFacts, limits: SizeLimits): SizeResult[] {
  const generated = facts.files.filter((file) => isGeneratedPath(file.path));
  const authored = facts.files.filter((file) => !isGeneratedPath(file.path));
  const additions = facts.additions - lineCount(generated, "additions");
  const deletions = facts.deletions - lineCount(generated, "deletions");
  const counts: Record<SizeTotal, number> = {
    "max-files-changed": facts.changedFiles - generated.length,
    "max-lines-changed": additions + deletions,
    "max-additions": additions,
    "max-deletions": deletions,
  };
  const totals = (Object.keys(SIZE_WORDS) as SizeTotal[]).map(function totalResult(id): SizeResult {
    const { key, verb, noun, counted } = SIZE_WORDS[id];
    const [count, max] = [counts[id], limits[id]];
    const over = max !== undefined && count > max;
    return {
      id,
      ...(over && { finding: `pull request ${verb} ${count} ${noun} (max ${max})` }),
      reason: `pull request is ${over ? "over" : "within"} the ${key} limit`,
      evidence: max === undefined ? [] : [`${count} ${counted} (max ${max})`],
      values: { [key]: count },
    };
  });
  return [...totals, perFileResult(authored, limits["max-lines-changed-per-file"])];
}

function sizeLimits(pack: CheckPack): SizeLimits {
  return Object.fromEntries((Object.entries(SIZE_RULES) as Array<[SizeRuleId, (typeof SIZE_RULES)[SizeRuleId]]>).map(([id, field]) => [id, pack.checks[id]?.[field]]));
}

interface CheckRules {
  enabled(id: CatalogId): boolean;
  sizes: SizeLimits;
  forbiddenGlobs: string[];
  tracker: IssueTracker;
  conventional?: ConventionalRule;
  risk: { hotFileFixes: number; migrationGlobs: readonly string[] };
  sensitiveGroups: Readonly<Record<string, SensitiveGroup>>;
  sensitiveMarks: Pick<RiskLevels, "failAt" | "labelAt">;
  /** The risk rule's levels, and the size limits whose crossing is its size signal. */
  riskLevels: RiskLevels;
  riskSizes: SizeLimits;
}

function resultOf(failed: boolean | null): CheckResult["result"] {
  if (failed === null) return "unconfirmed";
  return failed ? "fail" : "pass";
}

function conflictReason(conflicted: boolean | null): string {
  if (conflicted === null) return "mergeability not yet computed";
  return conflicted ? "merge conflicts with base" : "no merge conflicts";
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
      result: resultOf(failed),
      reason,
      evidence,
      output,
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
      // Cancelled checks are settled until re-run, so only running ones could not be checked yet.
      const output: CheckOutput = facts.checks === "pending" ? { kind: "could-not-check", reason: ci.reason } : { kind: "values", values: { status: ci.status } };
      result("ci-green", ci.failed, ci.reason, ci.names(facts), output);
    }
    if (on("no-merge-conflicts") && facts.mergeable === false) add("no-merge-conflicts", "blocked", "merge conflicts with base");
    const requested = facts.changesRequested;
    const requestedReason = facts.reviewAnswered ? REVIEW_ANSWERED_REASON : "a reviewer requested changes";
    if (requested.length) add(NO_CHANGES_REQUESTED, facts.reviewAnswered ? "awaiting-review" : "needs-author-update", requestedReason);
    result(NO_CHANGES_REQUESTED, requested.length > 0, requested.length ? requestedReason : "no changes requested", requested.map((login) => `changes requested by @${login}`), {
      kind: "values",
      values: { changesRequested: requested.length },
    });
    if (on("no-merge-conflicts") && !findings.length && facts.mergeable === null) add("no-merge-conflicts", "stale-unknown", "mergeability not yet computed");
    if (on("no-merge-conflicts")) {
      const conflicted = facts.mergeable === null ? null : !facts.mergeable;
      const reason = conflictReason(conflicted);
      result("no-merge-conflicts", conflicted, reason, [], conflicted === null ? { kind: "could-not-check", reason } : {
        kind: "values",
        values: { hasConflicts: conflicted },
      });
    }
    for (const size of sizeResults(facts, rules.sizes).filter((size) => on(size.id))) {
      if (size.finding) add(size.id, "needs-author-update", size.finding);
      result(size.id, size.finding !== undefined, size.reason, size.evidence, { kind: "values", values: size.values });
    }
    if (on("no-forbidden-paths") && rules.forbiddenGlobs.length > 0) {
      const matched = facts.paths.filter((path) => rules.forbiddenGlobs.some((glob) => globMatch(path, glob)));
      if (matched.length) add("no-forbidden-paths", "needs-author-update", "pull request touches a forbidden path");
      result("no-forbidden-paths", matched.length > 0, matched.length ? "pull request touches a forbidden path" : "no forbidden paths touched", matched, {
        kind: "values",
        values: { touchesForbiddenPaths: matched.length > 0 },
      });
    }
    if (on("regression-risk")) {
      const read = Object.entries(facts.fixes ?? {}).filter((entry): entry is [string, number] => entry[1] !== null);
      const unread = facts.fixes === undefined ? ["every file"] : Object.keys(facts.fixes).filter((path) => facts.fixes![path] === null);
      const evidence = [...hotFiles(new Map(read), rules.risk.hotFileFixes), ...matchingPaths(facts.paths, rules.risk.migrationGlobs).map((path) => `${path}: migration`)];
      if (evidence.length) {
        const reason = "changes code that regressed recently or a migration";
        add("regression-risk", "needs-decision", reason);
        result("regression-risk", true, reason, evidence, { kind: "values", values: { risky: true } });
      } else if (unread.length) {
        const reason = "could not read the recent history of some changed files";
        add("regression-risk", "stale-unknown", reason);
        result("regression-risk", null, reason, unread, { kind: "could-not-check", reason });
      } else result("regression-risk", false, "no recently fixed files or migrations changed", [], { kind: "values", values: { risky: false } });
    }
    if (on("sensitive-paths")) {
      const sensitive = sensitiveResult(facts, rules);
      if (sensitive.result === "fail") add("sensitive-paths", "needs-decision", sensitive.reason);
      checks.push(sensitive);
    }
    if (on("risk")) {
      const risk = riskResult(facts, rules);
      if (risk.result === "fail") add("risk", "needs-decision", risk.reason);
      if (risk.result === "unconfirmed") add("risk", "stale-unknown", risk.reason);
      checks.push(risk);
    }
    if (on("linked-issue") && rules.tracker !== "off") {
      const ref = issueReference(facts, rules.tracker);
      if (!ref) add("linked-issue", "needs-author-update", "pull request does not reference an issue");
      result("linked-issue", ref === null, ref ? "references an issue" : "pull request does not reference an issue", ref ? [ref] : [], {
        kind: "values",
        values: { linkedIssue: ref !== null },
      });
    }
    if (on("conventional-commits") && rules.conventional) {
      const { failed, reason } = conventionalResult(facts, rules.conventional);
      if (failed) add("conventional-commits", "needs-author-update", reason);
      result("conventional-commits", failed, reason, [], { kind: "values", values: { conventional: !failed } });
    }
    if (on("hidden-content")) {
      const hides = facts.hidden.length > 0;
      const reason = hides ? "pull request text hides content" : "no hidden content";
      if (hides) add("hidden-content", "needs-author-update", reason);
      result("hidden-content", hides, reason, facts.hidden, { kind: "values", values: { hidesContent: hides } });
    }
    if (on("no-duplicate")) {
      const { failed, reason } = duplicateResult(facts.openPulls);
      if (failed === null) add("no-duplicate", "stale-unknown", reason);
      if (failed) add("no-duplicate", "needs-author-update", reason);
      result("no-duplicate", failed, reason, [], failed === null ? { kind: "could-not-check", reason } : { kind: "values", values: { duplicate: failed } });
    }
    for (const rule of pack?.custom.filter(isTextCheck).filter(customCheckEnabled) ?? []) {
      const { failed, reason, evidence } = textResult(rule, facts);
      if (failed) add(rule.id, "needs-author-update", reason);
      checks.push({ check: rule.id, kind: "machine", result: failed ? "fail" : "pass", reason, evidence, output: { kind: "values", values: { matched: failed } } });
    }
    for (const rule of pack?.custom.filter(isPatternsCheck).filter(customCheckEnabled) ?? []) {
      const found = facts.patterns?.[rule.id] ?? { unread: "the changed files were not read" };
      if ("unread" in found) {
        const reason = `code patterns could not be checked: ${found.unread}`;
        add(rule.id, "stale-unknown", reason);
        checks.push({ check: rule.id, kind: "machine", result: "unconfirmed", reason, evidence: [], output: { kind: "could-not-check", reason } });
        continue;
      }
      const failed = found.matches.length > 0;
      const reason = patternsReason(failed, found);
      if (failed) add(rule.id, "needs-author-update", reason);
      checks.push({
        check: rule.id,
        kind: "machine",
        result: failed ? "fail" : "pass",
        reason,
        evidence: [...found.matches, ...found.skipped],
        output: { kind: "values", values: { matched: found.matches.length } },
        ...(found.skipped.length > 0 && { skipped: found.skipped }),
      });
    }
  }

  return finish(findings, checks, facts, pack);
}

const SENSITIVE_SHOWN = 5;

/** Up to five changed files as `group: path`, then how many more. */
function sensitiveEvidence(hits: readonly SensitiveHit[]): string[] {
  const lines = hits.flatMap(({ name, paths }) => paths.map((path) => `${name}: ${path}`));
  return lines.length > SENSITIVE_SHOWN ? [...lines.slice(0, SENSITIVE_SHOWN), `and ${lines.length - SENSITIVE_SHOWN} more`] : lines;
}

/** Fails at the highest changed group's level when that is `failAt` or above, and below it labels from `labelAt`. */
function sensitiveResult(facts: PrFacts, rules: CheckRules): CheckResult {
  const hits = sensitiveHits(facts.paths, rules.sensitiveGroups);
  const level = sensitiveLevel(hits);
  const outcome = riskOutcome(level, rules.sensitiveMarks);
  const base = { check: "sensitive-paths", kind: "machine" as const, evidence: sensitiveEvidence(hits), output: { kind: "values" as const, values: { level } } };
  if (hits.length === 0) return { ...base, result: "pass", reason: "no sensitive paths changed" };
  if (outcome === "fail") return { ...base, result: "fail", reason: "changes sensitive paths" };
  return { ...base, result: "pass", reason: "changes sensitive paths", ...(outcome === "label" && level !== "low" && { label: levelLabel("sensitive-paths", level) }) };
}

/** Each risk signal the pull request shows, in words, beside whether its changed files' recent history was read in full. */
function riskSignals(facts: PrFacts, rules: CheckRules): { signals: Map<RiskSignal, string[]>; sensitive: SensitiveHit[]; historyUnread: boolean } {
  const signals = new Map<RiskSignal, string[]>();
  // With sensitive paths on, a high group is that rule's to ask about, so a migration is asked about once.
  const sensitive = sensitiveHits(facts.paths, rules.sensitiveGroups).filter((hit) => hit.level !== "high" || !rules.enabled("sensitive-paths"));
  if (sensitive.some((hit) => hit.level === "medium")) signals.set("sensitive", []);
  const over = sizeResults(facts, rules.riskSizes).filter((size) => size.finding !== undefined);
  if (over.length) signals.set("size", over.flatMap((size) => Object.entries(size.values).map(([key, count]) => `${count} ${key}`)));
  if (untested(facts.paths)) signals.set("no-tests", ["no tests"]);
  const fixes = Object.values(facts.fixes ?? {});
  const hot = fixes.filter((count) => count !== null && count >= rules.risk.hotFileFixes).length;
  if (hot) signals.set("hot-files", [`${hot} recently fixed ${hot === 1 ? "file" : "files"}`]);
  if (facts.authorKind && (AUTHOR_GROUPS["first-timers"] as readonly string[]).includes(facts.authorKind)) signals.set("first-time", ["first-time contributor"]);
  return { signals, sensitive, historyUnread: hot === 0 && (facts.fixes === undefined || fixes.includes(null)) };
}

/**
 * The pull request's risk level from its signals: it fails at `failAt`, and below that labels from `labelAt`. When a
 * history left unread could have made a file hot and that would decide whether the rule fails, it is unconfirmed; a
 * label it could only have added is left off. It never waits on the host, which will not read that history again.
 */
function riskResult(facts: PrFacts, rules: CheckRules): CheckResult {
  const { signals, sensitive, historyUnread } = riskSignals(facts, rules);
  const floor = sensitiveLevel(sensitive);
  const level = riskLevel(new Set(signals.keys()), rules.riskLevels, floor);
  const outcome = riskOutcome(level, rules.riskLevels);
  const evidence = [...sensitive.map(({ name }) => `${name} paths`), ...[...signals.values()].flat()];
  const output: CheckOutput = { kind: "values", values: { level } };
  const unreadFails = riskOutcome(riskLevel(new Set([...signals.keys(), "hot-files"]), rules.riskLevels, floor), rules.riskLevels) === "fail";
  if (historyUnread && outcome !== "fail" && unreadFails) {
    return { check: "risk", kind: "machine", result: "unconfirmed", reason: "could not read the recent history of some changed files", evidence, output };
  }
  const base = { check: "risk", kind: "machine" as const, reason: `risk is ${level}`, evidence, output };
  if (outcome === "fail") return { ...base, result: "fail" };
  return { ...base, result: "pass", ...(outcome === "label" && level !== "low" && { label: levelLabel("risk", level) }) };
}

function patternsReason(failed: boolean, found: { skipped: string[]; checked: number }): string {
  if (failed) return "added code matches a code pattern";
  if (found.checked === 0 && found.skipped.length > 0) return "nothing checked: the only TypeScript or JavaScript changed is vendored, built or installed code";
  if (found.checked === 0) return "nothing checked: no TypeScript or JavaScript code added";
  return "no code pattern matched";
}

function deriveFromPack(facts: PrFacts, pack: CheckPack): DeterministicResult {
  return evaluate(facts, {
    enabled: (id) => catalogCheckEnabled(pack, id),
    sizes: sizeLimits(pack),
    forbiddenGlobs: pack.checks["no-forbidden-paths"]?.forbiddenGlobs ?? [],
    tracker: pack.checks["linked-issue"]?.tracker ?? "either",
    conventional: { types: pack.checks["conventional-commits"]?.types ?? CONVENTIONAL_TYPES, fields: pack.checks["conventional-commits"]?.fields ?? CONVENTIONAL_FIELDS },
    risk: { hotFileFixes: pack.checks["regression-risk"]?.hotFileFixes ?? DEFAULT_RISK.hotFileFixes, migrationGlobs: pack.checks["regression-risk"]?.migrationGlobs ?? DEFAULT_RISK.migrationGlobs },
    ...riskRules(pack),
  }, pack);
}

/** The sensitive groups and the size limits are the sensitive-paths and size rules' own, whether or not those rules are on. */
function riskRules(pack: CheckPack): Pick<CheckRules, "sensitiveGroups" | "sensitiveMarks" | "riskLevels" | "riskSizes"> {
  const [sensitive, risk] = [pack.checks["sensitive-paths"], pack.checks.risk];
  return {
    sensitiveGroups: sensitive?.sensitiveGroups ?? DEFAULT_SENSITIVE,
    sensitiveMarks: { failAt: sensitive?.failAt ?? DEFAULT_MARKS.failAt, labelAt: sensitive?.labelAt ?? DEFAULT_MARKS.labelAt },
    riskLevels: { medium: risk?.medium ?? DEFAULT_RISK_LEVELS.medium, high: risk?.high ?? DEFAULT_RISK_LEVELS.high, failAt: risk?.failAt ?? DEFAULT_RISK_LEVELS.failAt, labelAt: risk?.labelAt ?? DEFAULT_RISK_LEVELS.labelAt },
    riskSizes: { "max-files-changed": pack.checks["max-files-changed"]?.maxFiles ?? RECOMMENDED_SIZE.maxFiles, "max-lines-changed": pack.checks["max-lines-changed"]?.maxLines ?? RECOMMENDED_SIZE.maxLines },
  };
}

/** The hub read the stored policy, so what that read left out comes with the pack it mails. */
export function packFromInput(raw: unknown): CheckPack {
  const pack = readCheckPack(raw);
  const dropped = isRecord(raw) && Array.isArray(raw.dropped) ? raw.dropped.filter((note): note is string => typeof note === "string") : [];
  return dropped.length > 0 ? { ...pack, dropped: [...new Set([...(pack.dropped ?? []), ...dropped])] } : pack;
}

export function deriveState(facts: PrFacts, policy?: unknown, pack?: CheckPack | null): DeterministicResult {
  if (pack) return deriveFromPack(facts, pack);
  const legacy = repoPolicy(policy).checks;
  const enabled: Partial<Record<CatalogId, boolean>> = { "ci-green": legacy.ci, "no-merge-conflicts": legacy.conflicts };
  return evaluate(facts, {
    enabled: (id) => enabled[id] === true,
    sizes: {},
    forbiddenGlobs: [],
    tracker: "off",
    risk: DEFAULT_RISK,
    sensitiveGroups: DEFAULT_SENSITIVE,
    sensitiveMarks: DEFAULT_MARKS,
    riskLevels: DEFAULT_RISK_LEVELS,
    riskSizes: {},
  });
}
