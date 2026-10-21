// Interchange's workflow runtime cannot load in a browser yet, so the extension calls pr-triage's step handlers itself.
import { errorText } from "@corbits/common";
import { getChecks, getPostedCodeReview, getReviews, listIssueComments, listPrCommits, readPr, type GithubFetch } from "@corbits/github-reads";
import { checkName, repoPolicy, type CheckPack } from "@corbits/triage-contracts";
import { evaluate } from "@corbits/triage-workflows/actions/evaluate";
import { rules, type RulesItem } from "@corbits/triage-workflows/actions/rules";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import { assembleItem, listFiles, templatesFor, type RepoDocs } from "@corbits/triage-workflows/logic/facts";
import { NEEDS_JUDGE_REASON, type Verdict } from "@corbits/triage-workflows/logic/render";
import { fileNotes } from "./notes.ts";
import type { PolicyRead } from "./policy-source.ts";
import type { PrRef } from "./pr.ts";
import type { RuleState, TriageView, ViewRule } from "./view.ts";

type EffectContext = Parameters<typeof rules>[1];

const NO_EFFECTS: EffectContext = {
  async perform() {
    throw new Error("the extension performs no effects");
  },
};

// Docs are read only for the decision model, which is not asked here.
const NO_DOCS: RepoDocs = { docs: {}, rules: {} };

async function readItem(gh: GithubFetch, { repo, number }: PrRef, pack: CheckPack): Promise<RulesItem> {
  const [pr, reviews, comments, commits, files, templates] = await Promise.all([
    readPr(gh, repo, number),
    getReviews(gh, repo, number),
    listIssueComments(gh, repo, number),
    listPrCommits(gh, repo, number),
    listFiles(gh, repo, number),
    templatesFor(gh, repo, pack),
  ]);
  const checks = pr.sha ? await getChecks(gh, repo, pr.sha) : [];
  // Team membership needs read:org, which the read-only token is not asked for, so a step for a team is skipped as unknown.
  return assembleItem(number, { pr, checks, reviews, comments, commits, files, authorTeams: null }, { repo, policy: repoPolicy({}), pack, events: ["catch-up"], docs: NO_DOCS, templates, source: "github" });
}

/** A code review that cannot be read is said so beside the rules rather than failing their check. */
async function readCodeReview(gh: GithubFetch, { repo, number }: PrRef): Promise<TriageView["codeReview"]> {
  try {
    return { review: await getPostedCodeReview(gh, repo, number) };
  } catch (cause) {
    return { error: errorText(cause) };
  }
}

function stateOf(check: CheckResult): RuleState {
  if (check.kind === "model" && check.reason === NEEDS_JUDGE_REASON) return "not-evaluated";
  if (check.result === "unconfirmed") return "waiting";
  return check.result;
}

/**
 * pr-triage's rules and evaluate steps on one pull request, read from GitHub with the person's token; nothing is
 * written. The verdict is evaluated without the decision model, so it is named only when the rules decide it.
 */
export async function runStepsInBrowser(pr: PrRef, gh: GithubFetch, { pack, path, url }: PolicyRead): Promise<TriageView> {
  const [item, codeReview] = await Promise.all([readItem(gh, pr, pack), readCodeReview(gh, pr)]);
  const signal = new AbortController().signal;
  const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, signal);
  const ruledItem = ruled.items[0]!;
  const skipped = ruled.needsJudgment ? { ...ruledItem, judgeSkipped: true as const } : ruledItem;
  const verdict = (await evaluate({ items: [skipped], batch: false }, NO_EFFECTS, signal)) as Verdict;
  const named = verdict.checks.map((check) => ({ ...check, name: checkName(pack, check.check) }));
  const rows = named.map((check): ViewRule => ({ check: check.check, name: check.name, kind: check.kind, state: stateOf(check), reason: check.reason, evidence: check.evidence }));
  return {
    pr,
    headSha: ruledItem.facts.headSha,
    ranAt: new Date().toISOString(),
    policy: { path, url },
    rules: rows,
    decided: verdict.reason === NEEDS_JUDGE_REASON ? null : { verdict: verdict.verdict },
    notes: fileNotes(named),
    codeReview,
  };
}
