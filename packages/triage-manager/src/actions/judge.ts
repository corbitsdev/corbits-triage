import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { repoSourceOf } from "@corbits/triage-contracts";
import { Mailed, type MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, managerMailOf, manageMail } from "./hub.js";
import { Reviewer, TakeOutput } from "./manager.js";

/** How long the manager waits for a judge it deployed, from its deploy to its report. */
export const JUDGE_DEADLINE_MS = 60 * 60_000;

const RecallInput = type({ facts: { output: { items: "object[]", batch: "boolean" } }, take: { output: TakeOutput } });

function judgedRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const judged = (value as { judged?: unknown }).judged;
  if (!judged || typeof judged !== "object") return undefined;
  const entries = Object.entries(judged).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Answers the judge reported for this head, on this pass or stored on its reviewer. */
function answersOf({ head, judge, reviewers }: TakeOutput): Record<string, string> | undefined {
  return judgedRecord(judge) ?? reviewers.map((reviewer) => reviewer.kind === "judge" && reviewer.head === head ? judgedRecord(reviewer.result) : undefined).find((judged) => judged !== undefined);
}

/**
 * Puts the judge's stored answers onto the facts items before rules run, so a head the judge already answered is not
 * asked again. An item facts could not read is left as it is. With no answers, the facts output is unchanged.
 */
export async function recall(input: unknown): Promise<{ items: object[]; batch: boolean }> {
  const parsed = RecallInput(input);
  if (parsed instanceof type.errors) throw new Error(`recall: ${parsed.summary}`);
  const facts = parsed.facts.output;
  const judged = answersOf(parsed.take.output);
  if (!judged) return facts;
  const items = facts.items.map(function attach(item) {
    if ("error" in item && typeof item.error === "string") return item;
    const prior = "judged" in item && item.judged && typeof item.judged === "object" ? item.judged as Record<string, string> : {};
    return { ...item, judged: { ...prior, ...judged } };
  });
  return { items, batch: facts.batch };
}

const ScopeInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: "unknown" } });

function ownJudge(reviewers: readonly Reviewer[], head: string | undefined): Reviewer[] {
  return reviewers.filter((reviewer) => reviewer.kind === "judge" && reviewer.head === head);
}

/**
 * Whether the pass deploys the judge, and whether it goes on to the verdict. The judge runs once per head, when the
 * rules still need it and the release publishes one. A pass that deploys it, and every pass until it reports, posts
 * nothing. One that reported, reported a failure, or ran past its deadline goes on to the verdict and is not deployed again.
 */
export async function judgeScope(input: unknown): Promise<{ deploy: boolean; post: boolean }> {
  const parsed = ScopeInput(input);
  if (parsed instanceof type.errors) throw new Error(`judgeScope: ${parsed.summary}`);
  if (asRecord(parsed.rules.output)?.["needsJudgment"] !== true) return { deploy: false, post: false };
  const { head, judge, judgeFailed, reviewers } = parsed.take.output;
  if (publishedFor(repoSourceOf(managerMailOf(parsed.payload).pullRequest.source), "judge") === undefined) return { deploy: false, post: false };
  const pending = ownJudge(reviewers, head);
  const overdue = pending.some((reviewer) => reviewer.result === undefined && Date.parse(reviewer.deadline) <= Date.now());
  const settled = judge !== undefined || judgeFailed !== undefined || pending.some((reviewer) => reviewer.result !== undefined);
  if (judgeFailed !== undefined || overdue || settled) return { deploy: false, post: true };
  if (pending.some((reviewer) => reviewer.result === undefined)) return { deploy: false, post: false };
  return { deploy: true, post: false };
}

const DeployInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: "unknown" } });

/**
 * Deploys the judge from the host's published release. It is mailed the rules output and, to reply with, the mail that
 * wakes this manager. The mail waits for the new run until the judge's deadline.
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
  const content = JSON.stringify({ kind: "judge", tenantId, number: pullRequest.number, checkout: { source, repo: pullRequest.repo, sha: head }, rules, reply: { to: runId, content: manageMail(tenantId, pullRequest) } });
  return { reviewer: { kind: "judge", head, runId: judgeRun, deployedBy: runId, deadline }, mail: { tenantId, to: judgeRun, content, readyBy: deadline } };
}

const MailedInput = type({ deployJudge: { output: { reviewer: Reviewer } }, mailJudge: { output: "string" } });

/**
 * The judge becomes a reviewer to wait for once its mail went. A mail that failed by its deadline leaves the pass to
 * post the verdict without a judge.
 */
export async function judgeMailed(input: unknown): Promise<{ reviewer?: Reviewer; post: boolean }> {
  const parsed = MailedInput(input);
  if (parsed instanceof type.errors) throw new Error(`judgeMailed: ${parsed.summary}`);
  const mailed = Mailed(parsed.mailJudge.output);
  if (mailed instanceof type.errors) throw new Error(`judgeMailed: ${mailed.summary}`);
  return mailed.mailed ? { reviewer: parsed.deployJudge.output.reviewer, post: false } : { post: true };
}
