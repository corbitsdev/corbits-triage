import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { JudgeVerdict, repoSourceOf } from "@corbits/triage-contracts";
import { evaluate, type EvaluateOutput } from "@corbits/triage-workflows/actions/evaluate";
import type { Item } from "@corbits/triage-workflows/logic/item";
import { hostChecksPending } from "@corbits/triage-workflows/logic/render";
import { decided } from "@corbits/triage-workflows/logic/settled";
import { Mailed, type MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, managerMailOf } from "./hub.js";
import { Reviewer, TakeOutput } from "./manager.js";

/** How long the manager waits for a judge it deployed, from its deploy to its report. */
export const JUDGE_DEADLINE_MS = 60 * 60_000;

const VerdictInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { needsJudgment: "boolean", items: "object[]", batch: "boolean" } } });

/** Whether an item's rules wait on the host's own checks, so its judge is held until they finish. */
function waitingOnHost(items: readonly object[]): boolean {
  return (items as Item[]).some((item) => item.det !== undefined && hostChecksPending(item.det, item.noWait));
}

/**
 * The verdict the pass posts. When its rules need the judge and the judge reported a verdict for its head, that
 * verdict as the judge made it, after checking that its repository, number, head and host, and its comment's
 * repository and number, are the pass's. Otherwise pr-triage's evaluate of the rules output, the judge held back while
 * the host's checks run, so the head waits for them.
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
    return judged;
  }
  if (rules.needsJudgment && waitingOnHost(rules.items)) return evaluate({ ...rules, items: rules.items.map((item) => ({ ...item, judgeSkipped: true })) }, ctx, signal);
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
 * failure, or ran past its deadline goes on to the verdict and is not deployed again; one whose stored verdict the
 * host's checks could still change is deployed again.
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
  if (overdue || settled) return { deploy: false, post: true };
  if (open.length > 0) return { deploy: false, post: false };
  if (waitingOnHost(parsed.rules.output.items)) return { deploy: false, post: true };
  return { deploy: true, post: false };
}

const DeployInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: "unknown" } });

/**
 * Deploys the judge from the host's published release. It is mailed the rules output, and reports its verdict to the
 * hub, which wakes the pull request's manager. The mail waits for the new run until the judge's deadline.
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
 * The judge becomes a reviewer to wait for once its mail went. A mail that failed by its deadline leaves the pass to
 * post the verdict without a judge.
 */
export async function judgeMailed(input: unknown): Promise<{ reviewer?: Reviewer; post: boolean }> {
  const parsed = MailedInput(input);
  if (parsed instanceof type.errors) throw new Error(`judgeMailed: ${parsed.summary}`);
  const mailed = Mailed(parsed.mailJudge.output.reply);
  if (mailed instanceof type.errors) throw new Error(`judgeMailed: ${mailed.summary}`);
  return mailed.mailed ? { reviewer: parsed.deployJudge.output.reviewer, post: false } : { post: true };
}
