import {
  askRules,
  catalogCheckEnabled,
  CLOSED_FINDING,
  classificationSources,
  CONVENTIONAL_FIELDS,
  CONVENTIONAL_TYPES,
  customCheckEnabled,
  ISSUE_LINKS,
  isGeneratedPath,
  isTextCheck,
  labelRules,
  parseCheckPack,
  NO_CHANGES_REQUESTED,
  NOT_A_DRAFT,
  repoPolicy,
  SIZE_RULES,
  type AuthorKind,
  type CatalogId,
  type CheckOutput,
  type CheckPack,
  type ConventionalField,
  type IssueTracker,
  type SizeRuleId,
  type TextCustomCheck,
  type TriageEvent,
  type TrustTier,
  type WorkflowState,
} from "@corbits/triage-contracts";
import { isRecord } from "@corbits/common";
import type { Stack } from "@corbits/github-reads";
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

type RuleOutcome = Pick<CheckResult, "check" | "kind" | "result" | "onFail">;

/** None on a draft, which is not decided at all; a rule whose failure goes to a maintainer is not one. */
export function hardFailures<T extends RuleOutcome>(checks: readonly T[]): T[] {
  const failed = checks.filter((c) => c.kind === "machine" && c.result === "fail" && c.onFail === undefined);
  return failed.some((c) => c.check === NOT_A_DRAFT) ? [] : failed;
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
    sizes: sizeLimits(pack),
    forbiddenGlobs: pack.checks["no-forbidden-paths"]?.forbiddenGlobs ?? [],
    tracker: pack.checks["linked-issue"]?.tracker ?? "either",
    conventional: { types: pack.checks["conventional-commits"]?.types ?? CONVENTIONAL_TYPES, fields: pack.checks["conventional-commits"]?.fields ?? CONVENTIONAL_FIELDS },
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
    sizes: {},
    forbiddenGlobs: [],
    tracker: "off",
  });
}
