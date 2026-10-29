import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { JudgeVerdict, repoSourceOf } from "@corbits/triage-contracts";
import { evaluate, verdictOnFacts, type EvaluateOutput } from "@corbits/triage-workflows/actions/evaluate";
import type { Item } from "@corbits/triage-workflows/logic/item";
import { decided } from "@corbits/triage-workflows/logic/settled";
import { Mailed, type MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, managerMailOf } from "./hub.js";
import { Reviewer, TakeOutput, waitingOnHost } from "./manager.js";
import { ClearedVerdict } from "./review-clean.js";

/** How long the manager waits for a judge it deployed, from its deploy to its report. */
export const JUDGE_DEADLINE_MS = 60 * 60_000;

const VerdictInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { needsJudgment: "boolean", items: type("object[]").as<Item[]>(), batch: "boolean" } } });

/**
 * The verdict the pass posts. When its rules need the judge and the judge reported a verdict for its head, that
 * verdict, after checking that its repository, number, head and host, and its comment's repository and number, are the
 * pass's: its judgement as the judge made it, and its Dos made again from the pass's facts, which may have changed on
 * the same head since, as when CI finished. While the host's checks run, even with a verdict reported, and once the
 * manager stopped waiting with none, pr-triage's evaluate of the rules output with the judge held back, so the head
 * waits for them or is decided without it. Otherwise that evaluate as it is.
 */
export async function verdict(input: unknown, ctx: EffectContext, signal: AbortSignal): Promise<JudgeVerdict | EvaluateOutput> {
  const parsed = VerdictInput(input);
  if (parsed instanceof type.errors) throw new Error(`verdict: ${parsed.summary}`);
  const rules = parsed.rules.output;
  const judged = parsed.take.output.verdict;
  if (rules.needsJudgment && judged) {
    const { pullRequest } = managerMailOf(parsed.payload);
    const { repo, number, request } = judged;
    const matches = repo === pullRequest.repo && number === pullRequest.number && judged.headSha === parsed.take.output.head
      && request.repo === pullRequest.repo && request.number === pullRequest.number && repoSourceOf(judged.repoSource) === repoSourceOf(pullRequest.source);
    if (!matches) throw new Error(`verdict: the judge's verdict names ${repo}#${number} at ${judged.headSha}, not the pass's pull request and head`);
  }
  const unjudged = { ...rules, items: rules.items.map((item) => ({ ...item, judgeSkipped: true })) };
  // A head waiting on the host again, as when its CI runs again on the same commit, waits before any judgement is posted.
  if (rules.needsJudgment && waitingOnHost(rules.items)) return evaluate(unjudged, ctx, signal);
  if (rules.needsJudgment && judged) {
    const { number } = judged;
    const item = rules.items.find(({ facts }) => facts.number === number && facts.headSha === judged.headSha);
    const stored = ClearedVerdict(judged);
    if (stored instanceof type.errors) throw new Error(`verdict: ${stored.summary}`);
    // Rules that read past the judge's head have no facts for it, so its verdict stands as the judge made it.
    return item ? verdictOnFacts(item, stored) : judged;
  }
  if (rules.needsJudgment && parsed.take.output.stopped !== undefined) return evaluate(unjudged, ctx, signal);
  return evaluate(rules, ctx, signal);
}

const ScopeInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { needsJudgment: "boolean", items: "object[]" } } });

function ownJudge(reviewers: readonly Reviewer[], head: string | undefined): Reviewer[] {
  return reviewers.filter((reviewer) => reviewer.kind === "judge" && reviewer.head === head);
}

/** A verdict an earlier pass stored that the host's checks could still change. */
function undecided(reviewer: Reviewer, head: string | undefined): boolean {
  const verdict = JudgeVerdict(reviewer.result);
  return !(verdict instanceof type.errors) && (head === undefined || !decided(verdict, head));
}

/**
 * Whether the pass deploys the judge, and whether it goes on to the verdict. The judge runs when the rules still need
 * it, the release publishes one and the host's checks have finished; while they run, the pass goes on to a verdict that
 * waits for them. A pass that deploys it, and every pass until it reports, posts nothing. One that reported, reported a
 * failure, ran past its deadline or whose run ended goes on to the verdict and is not deployed again; one whose stored verdict the
 * host's checks could still change is deployed again. A manager that stopped waiting deploys no judge it would not wait for.
 */
export async function judgeScope(input: unknown): Promise<{ deploy: boolean; post: boolean }> {
  const parsed = ScopeInput(input);
  if (parsed instanceof type.errors) throw new Error(`judgeScope: ${parsed.summary}`);
  if (!parsed.rules.output.needsJudgment) return { deploy: false, post: false };
  const { head, judge, judgeFailed, reviewers } = parsed.take.output;
  if (publishedFor(repoSourceOf(managerMailOf(parsed.payload).pullRequest.source), "judge") === undefined) return { deploy: false, post: false };
  const pending = ownJudge(reviewers, head);
  const open = pending.filter((reviewer) => reviewer.result === undefined);
  const overdue = open.some((reviewer) => Date.parse(reviewer.deadline) <= Date.now());
  const settled = judge !== undefined || judgeFailed !== undefined || pending.some((reviewer) => reviewer.result !== undefined && !undecided(reviewer, head));
  if (overdue || settled || parsed.take.output.stopped !== undefined) return { deploy: false, post: true };
  if (open.length > 0) return { deploy: false, post: false };
  if (waitingOnHost(parsed.rules.output.items)) return { deploy: false, post: true };
  return { deploy: true, post: false };
}

const DeployInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: "unknown" } });

/**
 * Deploys the judge from the host's published release. It is mailed the rules output, and reports its verdict to the
 * hub, which wakes the pull request's manager. The mail waits for the new run to publish its public key, giving up when
 * the run ends first or at the judge's deadline.
 */
export async function deployJudge(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ reviewer: Reviewer; mail: MailInput }> {
  const parsed = DeployInput(input);
  if (parsed instanceof type.errors) throw new Error(`deployJudge: ${parsed.summary}`);
  const { tenantId, runId, pullRequest } = managerMailOf(parsed.payload);
  const { head } = parsed.take.output;
  const rules = parsed.rules.output;
  if (head === undefined || !rules) throw new Error("deployJudge: the pass names no head");
  const source = repoSourceOf(pullRequest.source);
  const release = publishedFor(source, "judge");
  if (!release) throw new Error("deployJudge: release.json publishes no judge for the host");
  const judgeRun = await deploy(ctx, "deployJudge", tenantId, release);
  const deadline = new Date(Date.now() + JUDGE_DEADLINE_MS).toISOString();
  const content = JSON.stringify({ kind: "judge", tenantId, number: pullRequest.number, checkout: { source, repo: pullRequest.repo, sha: head }, rules });
  return { reviewer: { kind: "judge", head, runId: judgeRun, deployedBy: runId, deadline }, mail: { tenantId, to: judgeRun, content, readyBy: deadline } };
}

const MailedInput = type({ deployJudge: { output: { reviewer: Reviewer } }, mailJudge: { output: { reply: "string" } } });

/**
 * The judge becomes a reviewer to wait for once its mail went. A mail that failed, because the run ended before it was
 * ready or its deadline passed, leaves the pass to post the verdict without a judge.
 */
export async function judgeMailed(input: unknown): Promise<{ reviewer?: Reviewer; post: boolean }> {
  const parsed = MailedInput(input);
  if (parsed instanceof type.errors) throw new Error(`judgeMailed: ${parsed.summary}`);
  const mailed = Mailed(parsed.mailJudge.output.reply);
  if (mailed instanceof type.errors) throw new Error(`judgeMailed: ${mailed.summary}`);
  return mailed.mailed ? { reviewer: parsed.deployJudge.output.reviewer, post: false } : { post: true };
}
