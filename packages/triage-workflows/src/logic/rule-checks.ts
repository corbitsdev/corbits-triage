import type { RuleCustomCheck } from "@corbits/triage-contracts";
import type { CheckResult, Finding, PrFacts } from "./checks.js";
import { globMatch } from "./glob.js";

const MAX_DIFF_HITS = 5;

type Outcome = { failed: boolean | null; reason: string; evidence?: string[]; state?: Finding["state"] };

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
    else if (!row.startsWith("-")) line++;
  }
  return out;
}

function outcome(check: RuleCustomCheck, facts: PrFacts): Outcome {
  const paths = facts.paths ?? [];
  switch (check.rule) {
    case "paths-unchanged": {
      const hit = matching(paths, check.globs);
      return { failed: hit.length > 0, reason: hit.length ? "changes a path that must not change" : "leaves the protected paths unchanged", evidence: hit };
    }
    case "paths-together": {
      const changed = matching(paths, check.changed);
      const required = matching(paths, check.requires);
      const failed = changed.length > 0 && required.length === 0;
      return { failed, reason: failed ? "changes one set of paths without the other" : "changes paths together", evidence: failed ? [...changed, `no change to ${check.requires.join(", ")}`] : [] };
    }
    case "title-pattern": {
      const failed = !new RegExp(check.pattern).test(facts.title);
      return { failed, reason: failed ? "title does not match the pattern" : "title matches the pattern", evidence: [facts.title] };
    }
    case "branch-pattern": {
      if (!facts.branch) return { failed: null, reason: "branch name is not known" };
      const failed = !new RegExp(check.pattern).test(facts.branch);
      return { failed, reason: failed ? "branch does not match the pattern" : "branch matches the pattern", evidence: [facts.branch] };
    }
    case "label-required": {
      const failed = !(facts.labels ?? []).includes(check.label);
      return { failed, reason: failed ? `label ${check.label} is missing` : `label ${check.label} is present`, evidence: facts.labels ?? [], state: "needs-decision" };
    }
    case "diff-excludes": {
      const files = facts.files ?? [];
      if (files.some((file) => file.patch === undefined || file.patchTruncated)) return { failed: null, reason: "some patches are not available" };
      const re = new RegExp(check.pattern);
      // Only the location is recorded: the matched text may be a secret.
      const hits = files.flatMap((file) => addedLines(file.patch ?? "").filter(({ text }) => re.test(text)).map(({ line }) => `${file.path}:${line}`));
      return { failed: hits.length > 0, reason: hits.length ? "an added line matches the excluded pattern" : "no added line matches the excluded pattern", evidence: hits.slice(0, MAX_DIFF_HITS) };
    }
    case "min-approvals": {
      const failed = facts.approvals < check.count;
      return { failed, reason: failed ? "not enough approvals" : "enough approvals", evidence: [`${facts.approvals} of ${check.count} approvals`], state: "awaiting-review" };
    }
  }
}

/** Evaluates the pack's rule custom checks from facts alone. Patterns were validated when the pack was read. */
export function evaluateRuleChecks(facts: PrFacts, rules: RuleCustomCheck[]): { findings: Finding[]; checks: CheckResult[] } {
  const findings: Finding[] = [];
  const checks: CheckResult[] = [];
  for (const check of rules) {
    const { failed, reason, evidence = [], state = "needs-author-update" } = outcome(check, facts);
    if (failed) findings.push({ check: check.id, state, reason: `${check.name}: ${reason}` });
    checks.push({ check: check.id, kind: "machine", result: failed === null ? "unconfirmed" : failed ? "fail" : "pass", reason, evidence });
  }
  return { findings, checks };
}
