import type { CheckPack, CustomCheck } from "@corbits/triage-contracts";
import type { CheckResult, PrFacts } from "@corbits/triage-workflows/logic/checks";
import type { PageAction } from "./page-actions.ts";
import type { FileNote } from "./view.ts";

/** Failing CI jobs linked one by one, at most; past that, one link to the Checks tab. */
const MOST_JOBS = 3;

export type SuggestInput = {
  facts: PrFacts;
  checks: Array<CheckResult & { name: string }>;
  pack: CheckPack;
  /** Each failing CI job's page, by the check's name, when the CI check failed. */
  jobs: Record<string, string>;
};

/** The checks a pack comment Do already words, so the same check gets no second draft. */
function wordedByDos(pack: CheckPack): Set<string> {
  return new Set(pack.actions.flatMap((action) => ("no" in action.branches && action.branches.no?.some((step) => step.kind === "comment") ? action.checks : [])));
}

function sentence(text: string): string {
  const trimmed = text.replace(/^[^:]+: /, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

/**
 * The steps a run's failing checks point to, each one a person can take on GitHub's page as themselves, and the files
 * they point at. Everything here comes from what the run read; nothing is suggested a check did not find.
 */
export function suggest({ facts, checks, pack, jobs }: SuggestInput): { actions: PageAction[]; notes: FileNote[] } {
  const { repo, number, headSha } = facts;
  const base = `/${repo}/pull/${number}`;
  const head = headSha.slice(0, 12);
  const worded = wordedByDos(pack);
  const custom = new Map<string, CustomCheck>(pack.custom.map((check) => [check.id, check]));
  const actions: PageAction[] = [];
  const notes: FileNote[] = [];

  function add(check: CheckResult & { name: string }, action: Omit<PageAction, "id" | "auto" | "source" | "values" | "teams"> & Partial<Pick<PageAction, "values" | "teams">>, part: string = action.kind) {
    actions.push({ values: [], teams: [], ...action, id: `${head}:${check.check}:${part}`, auto: false, source: "check" });
  }

  function protectedPaths(check: CheckResult & { name: string }) {
    for (const path of check.evidence) notes.push({ path, check: check.name, reason: "Touches a protected path." });
  }

  for (const check of checks.filter((each) => each.result === "fail" && !each.gate)) {
    const rule = custom.get(check.check);
    const why = `${check.name} failed. ${sentence(check.reason)}`;
    // A custom rule is suggested for by its kind, a built-in one by its id, so a custom id never reads as a built-in's.
    if (rule) {
      if (rule.kind !== "rule") continue;
      switch (rule.rule) {
        case "label-required":
          add(check, { kind: "labels", title: `Add label ${rule.label}`, why, values: [rule.label] });
          break;
        case "title-pattern":
          add(check, { kind: "edit-title", title: "Edit this pull request's title", why, hint: rule.pattern });
          break;
        case "paths-unchanged":
          protectedPaths(check);
          break;
        case "diff-excludes":
          for (const hit of check.evidence) {
            const at = /^(.*):(\d+)$/.exec(hit);
            if (at) notes.push({ path: at[1]!, line: Number(at[2]), check: check.name, reason: "Added line matches the excluded pattern." });
          }
          break;
      }
      continue;
    }
    switch (check.check) {
      case "linked-issue":
        add(check, { kind: "edit-body", title: "Link an issue in this pull request's description", why, body: (pack.checks["linked-issue"]?.tracker ?? "either") === "linear" ? "Closes " : "Closes #" });
        break;
      case "max-files-changed":
      case "max-lines-changed":
        if (!worded.has(check.check)) add(check, { kind: "comment", title: "Ask the author to split this pull request", why, body: `This is a lot to review in one pass (${check.evidence.join(", ")}). Could you split it into smaller pull requests?` });
        break;
      case "ci-green": {
        const linked = (facts.failingChecks ?? []).filter((name) => jobs[name]).slice(0, MOST_JOBS);
        for (const name of linked) add(check, { kind: "link", title: `Open the log of failing job ${name}`, why: `${check.name} failed.`, href: jobs[name]! }, `link:${name}`);
        if (!linked.length) add(check, { kind: "link", title: "Open this pull request's failing checks", why, href: `${base}/checks` });
        break;
      }
      case "no-merge-conflicts":
        add(check, { kind: "link", title: "Resolve this pull request's merge conflicts", why, href: `${base}/conflicts` });
        break;
      case "no-forbidden-paths":
        protectedPaths(check);
        break;
    }
  }
  // The changed lines a failing check cites, marked where they are in the Files tab.
  for (const check of checks.filter((each) => each.result === "fail" && !each.gate)) {
    const items = "items" in check.output ? check.output.items ?? [] : [];
    for (const item of items) {
      if (typeof item !== "string" && item.added) notes.push({ path: item.path, line: item.added.start, check: check.name, reason: sentence(check.reason) });
    }
  }
  if (facts.state === "open" && facts.draft) {
    actions.push({ id: `${head}:draft:ready`, kind: "ready", title: "Mark this pull request ready for review", why: "It is a draft, so it cannot merge and reviewers are not asked yet.", values: [], teams: [], auto: false, source: "check" });
  }
  return { actions, notes };
}
