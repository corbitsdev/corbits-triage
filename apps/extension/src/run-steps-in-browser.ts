// Interchange's workflow runtime cannot load in a browser yet, so the extension calls pr-triage's step handlers itself.
import { getChecks, getReviews, listIssueComments, listPrCommits, readPr, readRepoDocsPage, repoDocs, type GithubFetch, type RepoDocsPage } from "@corbits/github-reads";
import { checkName, classificationSources, doSentence, repoPolicy, type CheckPack } from "@corbits/triage-contracts";
import { evaluate } from "@corbits/triage-workflows/actions/evaluate";
import { parts } from "@corbits/triage-workflows/actions/parts";
import { rules, type RulesItem } from "@corbits/triage-workflows/actions/rules";
import type { SuggestedAction, SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import { hasModelChecks, type CheckResult } from "@corbits/triage-workflows/logic/checks";
import { assembleItem, listFiles, type RepoDocs } from "@corbits/triage-workflows/logic/facts";
import { NEEDS_JUDGE_REASON, type Verdict } from "@corbits/triage-workflows/logic/render";
import { fileNotes } from "./notes.ts";
import type { PolicyRead } from "./policy-source.ts";
import type { PrRef } from "./pr.ts";
import { askChunk, type SystemOneSettings } from "./system-one.ts";
import type { RuleState, TriageView, ViewRule } from "./view.ts";

type EffectContext = Parameters<typeof rules>[1];

const NO_EFFECTS: EffectContext = {
  async perform() {
    throw new Error("the extension performs no effects");
  },
};

const NO_DOCS: RepoDocs = { docs: {}, rules: {} };

async function readDocs(gh: GithubFetch, repo: string): Promise<RepoDocs> {
  const pages: RepoDocsPage[] = [await readRepoDocsPage(gh, repo)];
  for (;;) {
    const { next, ref } = pages.at(-1)!;
    if (next === undefined) return repoDocs(pages);
    const page = await readRepoDocsPage(gh, repo, { ref, offset: next });
    if (page.next !== undefined && page.next <= next) throw new Error(`github_read_repo_docs did not advance past offset ${next}`);
    pages.push(page);
  }
}

async function readItem(gh: GithubFetch, { repo, number }: PrRef, pack: CheckPack, docs: RepoDocs): Promise<RulesItem> {
  const [pr, reviews, comments, commits, files] = await Promise.all([
    readPr(gh, repo, number),
    getReviews(gh, repo, number),
    listIssueComments(gh, repo, number),
    listPrCommits(gh, repo, number),
    listFiles(gh, repo, number),
  ]);
  const checks = pr.sha ? await getChecks(gh, repo, pr.sha) : [];
  // Team membership needs read:org, which the read-only token is not asked for, so a step for a team is skipped as unknown.
  return assembleItem(number, { pr, checks, reviews, comments, commits, files, authorTeams: null }, { repo, policy: repoPolicy({}), pack, events: ["catch-up"], docs });
}

function stateOf(check: CheckResult): RuleState {
  if (check.kind === "model" && check.reason === NEEDS_JUDGE_REASON) return "not-evaluated";
  if (check.result === "unconfirmed") return "waiting";
  return check.result;
}

function isDo(action: SuggestedAction): action is SuggestedDo {
  return "effectId" in action;
}

function stepSentence(step: SuggestedDo, repo: string): string[] {
  const sentence = doSentence(step.kind, step.target, repo);
  return sentence === null ? [] : [sentence];
}

/** The labels, comment and other steps the hub would post for a verdict reached without the decision model. */
function posted(verdict: Verdict, repo: string) {
  const dos = verdict.actions.filter(isDo);
  const labelDos = dos.flatMap((step) => (step.kind === "labels" && "labels" in step.target ? step.target.labels : []));
  const steps = dos.filter((step) => step.kind !== "labels").flatMap((step) => stepSentence(step, repo));
  return { labels: [...new Set([...verdict.request.labels, ...labelDos])], comment: verdict.request.comment, steps };
}

async function modelChecks(item: RulesItem, systemOne: SystemOneSettings, signal: AbortSignal): Promise<CheckResult[]> {
  const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, signal);
  const asked = { ...ruled, judge: { output: await Promise.all(ruled.chunks.map((chunk) => askChunk(chunk, systemOne))) } };
  const { chunks } = await parts(asked, NO_EFFECTS, signal);
  const answered = chunks.length > 0 ? { ...asked, judgeParts: { output: await Promise.all(chunks.map((chunk) => askChunk(chunk, systemOne))) } } : asked;
  const verdict = (await evaluate(answered, NO_EFFECTS, signal)) as Verdict;
  return verdict.checks.filter((check) => check.kind === "model");
}

/**
 * pr-triage's rules and evaluate steps on one pull request, read from GitHub with the person's token; nothing is
 * written. The verdict is evaluated without the decision model, so it is named only when the rules decide it. With a
 * decision model set, its rules are asked too and their answers listed, without naming the verdict they lead to.
 */
export async function runStepsInBrowser(pr: PrRef, gh: GithubFetch, { pack, origin }: PolicyRead, systemOne: SystemOneSettings | null): Promise<TriageView> {
  const asking = systemOne !== null && hasModelChecks(classificationSources(pack));
  const item = await readItem(gh, pr, pack, asking ? await readDocs(gh, pr.repo) : NO_DOCS);
  const signal = new AbortController().signal;
  const ruled = await rules({ items: [item], batch: false }, NO_EFFECTS, signal);
  const ruledItem = ruled.items[0]!;
  const skipped = ruled.needsJudgment ? { ...ruledItem, judgeSkipped: true as const } : ruledItem;
  const verdict = (await evaluate({ items: [skipped], batch: false }, NO_EFFECTS, signal)) as Verdict;
  const answered = asking && ruled.needsJudgment ? await modelChecks(item, systemOne, signal) : [];
  const checks = verdict.checks.map((check) => answered.find((each) => each.check === check.check) ?? check);
  const named = checks.map((check) => ({ ...check, name: checkName(pack, check.check) }));
  const rows = named.map((check): ViewRule => ({ check: check.check, name: check.name, kind: check.kind, state: stateOf(check), reason: check.reason, evidence: check.evidence }));
  return {
    pr,
    headSha: ruledItem.facts.headSha,
    ranAt: new Date().toISOString(),
    policy: origin,
    modelAsked: asking,
    rules: rows,
    decided: verdict.reason === NEEDS_JUDGE_REASON ? null : { verdict: verdict.verdict, ...posted(verdict, pr.repo) },
    notes: fileNotes(named),
  };
}
