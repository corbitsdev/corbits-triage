import type { RepoRole, RuleCustomCheck } from "@corbits/triage-contracts";
import { RE2JS } from "re2js";
import { missingFrom } from "./actions.js";
import type { CheckResult, Finding, PrFacts, PrFileFacts } from "./checks.js";
import { globMatch } from "./glob.js";

const MAX_DIFF_HITS = 5;

/** A gate decides an action's branch without being a defect, so it adds no finding. */
type Outcome = { failed: boolean | null; reason: string; evidence?: string[]; state?: Finding["state"]; gate?: true };

function matching(paths: string[], globs: string[]): string[] {
  return paths.filter((path) => globs.some((glob) => globMatch(path, glob)));
}

/** Lines a patch adds, numbered in the new file. */
function addedLines(patch: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let line = 0;
  for (const row of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) line = Number(hunk[1]) - 1;
    else if (row.startsWith("+")) out.push({ line: ++line, text: row.slice(1) });
    else if (!row.startsWith("-") && !row.startsWith("\\")) line++;
  }
  return out;
}

/** Locations only: the matched text may be a secret. */
function diffHits(files: PrFileFacts[], re: RE2JS): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (file.patch === undefined) continue;
    for (const { line, text } of addedLines(file.patch)) if (re.test(text)) hits.push(`${file.path}:${line}`);
  }
  return hits;
}

/** A file whose additions could not all be scanned: no patch, or one cut short. */
function unscanned(file: PrFileFacts): boolean {
  return (file.additions ?? 0) > 0 && (file.patch === undefined || file.patchTruncated === true);
}

type AuthorRule = Extract<RuleCustomCheck, { rule: "author" }>;

/** Team membership is not in the facts, so a role that also names teams cannot say no. */
function named(check: Exclude<AuthorRule, { who: "kinds" }>, author: string, roles: Record<string, RepoRole>): Omit<Outcome, "gate"> {
  if (check.who === "users") return oneOf(check.users, author);
  const role = roles[check.role];
  if (!role) return { failed: null, reason: `role ${check.role} is not defined` };
  const users = role.users ?? [];
  const teams = role.teams ?? [];
  if (!users.length && !teams.length) return { failed: null, reason: `role ${check.role} names no people` };
  const outcome = oneOf(users, author);
  if (outcome.failed && teams.length) return { failed: null, reason: `role ${check.role} names teams, and team membership is not known` };
  return outcome;
}

function oneOf(users: string[], author: string): Omit<Outcome, "gate"> {
  const failed = missingFrom(users, [author]).length > 0;
  return { failed, reason: failed ? "author is not one of the people named" : "author is one of the people named" };
}

function author(check: AuthorRule, facts: PrFacts, roles: Record<string, RepoRole>): Outcome {
  const kind = facts.authorKind;
  if (!facts.author) return { failed: null, reason: "the author is not known", gate: true };
  const evidence = [`@${facts.author}${kind ? ` (${kind})` : ""}`];
  if (check.who === "kinds") {
    if (!kind) return { failed: null, reason: "the author's kind is not known", evidence, gate: true };
    const failed = !check.kinds.includes(kind);
    return { failed, reason: failed ? `author is ${kind}, not ${check.kinds.join(" or ")}` : `author is ${kind}`, evidence, gate: true };
  }
  return { ...named(check, facts.author, roles), evidence, gate: true };
}

function outcome(check: RuleCustomCheck, facts: PrFacts, roles: Record<string, RepoRole>): Outcome {
  const paths = facts.paths ?? [];
  switch (check.rule) {
    case "paths-unchanged": {
      const hit = matching(paths, check.globs);
      return { failed: hit.length > 0, reason: hit.length ? "changes a protected path" : "leaves the protected paths unchanged", evidence: hit };
    }
    case "paths-together": {
      const changed = matching(paths, check.changed);
      const required = matching(paths, check.requires);
      const failed = changed.length > 0 && required.length === 0;
      return { failed, reason: failed ? `changes ${changed.join(", ")} without ${check.requires.join(", ")}` : "changes paths together" };
    }
    case "title-pattern": {
      const failed = !RE2JS.compile(check.pattern).test(facts.title);
      return { failed, reason: failed ? "title does not match the pattern" : "title matches the pattern" };
    }
    case "branch-pattern": {
      if (!facts.branch) return { failed: null, reason: "branch name is not known" };
      const failed = !RE2JS.compile(check.pattern).test(facts.branch);
      return { failed, reason: failed ? "branch does not match the pattern" : "branch matches the pattern" };
    }
    case "label-required": {
      const failed = missingFrom(facts.labels, [check.label]).length > 0;
      return { failed, reason: failed ? `label ${check.label} is missing` : `label ${check.label} is present`, state: "awaiting-review" };
    }
    case "diff-excludes": {
      const files = facts.files ?? [];
      const hits = diffHits(files, RE2JS.compile(check.pattern));
      if (hits.length) return { failed: true, reason: "an added line matches the excluded pattern", evidence: hits.slice(0, MAX_DIFF_HITS) };
      if (files.some(unscanned)) return { failed: null, reason: "some added lines could not be scanned" };
      return { failed: false, reason: "no added line matches the excluded pattern" };
    }
    case "min-approvals": {
      const failed = facts.approvals < check.count;
      return { failed, reason: failed ? "not enough approvals" : "enough approvals", evidence: [`${facts.approvals} of ${check.count} approvals`], state: "awaiting-review" };
    }
    case "author":
      return author(check, facts, roles);
  }
}

/** Evaluates the pack's rule custom checks from facts alone. Patterns were validated when the pack was read. */
export function evaluateRuleChecks(facts: PrFacts, rules: RuleCustomCheck[], roles: Record<string, RepoRole>): { findings: Finding[]; checks: CheckResult[] } {
  const findings: Finding[] = [];
  const checks: CheckResult[] = [];
  for (const check of rules) {
    const { failed, reason: detail, evidence = [], state = "needs-author-update", gate } = outcome(check, facts, roles);
    const reason = `${check.name}: ${detail}`;
    if (failed && !gate) findings.push({ check: check.id, state, reason });
    checks.push({ check: check.id, kind: "machine", result: failed === null ? "unconfirmed" : failed ? "fail" : "pass", reason, evidence, ...(gate ? { gate } : {}) });
  }
  return { findings, checks };
}
