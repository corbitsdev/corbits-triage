import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { isFromTriageSender, repoSourceOf, TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { Mailed, MailInput } from "../mail.js";
import { publishedFor, TIMINGS } from "../release.js";
import { deploy, endRun, mailOf, managedBy, manageMail, noteDeployed } from "./hub.js";

/** The hub's mail to a listener: the repository and, as a reconciler's mail does, the heads it names as `items`. */
const ListenerMail = type({
  tenantId: "string > 0",
  repo: "string > 0",
  "repoSource?": "string",
  "prNumber?": "number.integer > 0",
  "items?": type({ prNumber: "number.integer > 0" }).array(),
});

/**
 * Deploys a manager from the host's published release for each pull request the hub's mail names, tells the hub which
 * run it deployed, and wakes it; the manager reads what to do from the hub. Only the hub's mail moves the listener; a mail that names no pull request, or a
 * listener published without a manager, fails the body.
 */
export async function forward(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ mails: MailInput[] }> {
  if (!isFromTriageSender(input)) throw new Error("forward: the mail is not from the hub's Triage sender");
  const mail = ListenerMail(mailOf(input).request);
  if (mail instanceof type.errors) throw new Error(`forward: ${mail.summary}`);
  const numbers = mail.items?.map((item) => item.prNumber) ?? (mail.prNumber === undefined ? [] : [mail.prNumber]);
  if (numbers.length === 0) throw new Error(`forward: the mail for ${mail.repo} names no pull request`);
  const source = repoSourceOf(mail.repoSource);
  const release = publishedFor(source, "manager");
  if (!release) throw new Error(`${TRIAGE_LISTENERS[source]} needs the release's manager in release.json, which the hub publishes beside it`);
  const mails: MailInput[] = [];
  for (const number of numbers) {
    const pullRequest = { source, repo: mail.repo, number };
    const runId = await deploy(ctx, `deploy:${number}`, mail.tenantId, release);
    await noteDeployed(ctx, `deployed:${number}`, mail.tenantId, pullRequest, runId);
    mails.push({ tenantId: mail.tenantId, to: runId, content: manageMail(mail.tenantId, pullRequest), readyBy: new Date(Date.now() + TIMINGS.managerReadyMs).toISOString() });
  }
  return { mails };
}

const Replies = type({ reply: "string" }).array();
const Cancelled = type({ runId: "string > 0", reason: "string" }).array();
const UnwokenInput = type({ forward: { output: { mails: MailInput.array() } }, mail: { output: Replies } });
const RetryInput = type({ forward: { output: { mails: MailInput.array() } }, unwoken: { output: { cancelled: Cancelled } } });
const RetriedInput = type({ retry: { output: { mails: MailInput.array() } }, remail: { output: Replies } });

/**
 * Cancels each manager this body deployed whose wake mail did not go, through the stock stop-run route, so a manager
 * that was never woken does not stay deployed; the output names each with why its mail failed.
 */
export async function unwoken(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ cancelled: { runId: string; reason: string }[] }> {
  const parsed = UnwokenInput(input);
  if (parsed instanceof type.errors) throw new Error(`unwoken: ${parsed.summary}`);
  return cancelUnwoken(ctx, parsed.forward.output.mails, parsed.mail.output);
}

/**
 * Deploys one fresh manager for each pull request whose manager `unwoken` cancelled, as a sidecar slow to start makes
 * the first wake fail, and wakes it with the same mail.
 */
export async function retry(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ mails: MailInput[] }> {
  const parsed = RetryInput(input);
  if (parsed instanceof type.errors) throw new Error(`retry: ${parsed.summary}`);
  const cancelled = new Set(parsed.unwoken.output.cancelled.map((run) => run.runId));
  const mails: MailInput[] = [];
  for (const mail of parsed.forward.output.mails.filter((sent) => cancelled.has(sent.to))) {
    const { tenantId, pullRequest } = managedBy(JSON.parse(mail.content) as Record<string, unknown>);
    const source = repoSourceOf(pullRequest.source);
    const release = publishedFor(source, "manager");
    if (!release) throw new Error(`${TRIAGE_LISTENERS[source]} needs the release's manager in release.json, which the hub publishes beside it`);
    const runId = await deploy(ctx, `redeploy:${pullRequest.number}`, tenantId, release);
    await noteDeployed(ctx, `redeployed:${pullRequest.number}`, tenantId, pullRequest, runId);
    mails.push({ ...mail, to: runId, readyBy: new Date(Date.now() + TIMINGS.managerReadyMs).toISOString() });
  }
  return { mails };
}

/**
 * Cancels each manager `retry` deployed whose wake mail did not go either, and deploys no other: the hub's start grace
 * on the claim lapses, and the pull request's next event or the reconciler re-queuing its head asks again.
 */
export async function unwokenAgain(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ cancelled: { runId: string; reason: string }[] }> {
  const parsed = RetriedInput(input);
  if (parsed instanceof type.errors) throw new Error(`unwokenAgain: ${parsed.summary}`);
  return cancelUnwoken(ctx, parsed.retry.output.mails, parsed.remail.output);
}

async function cancelUnwoken(ctx: EffectContext, mails: readonly MailInput[], replies: readonly { reply: string }[]): Promise<{ cancelled: { runId: string; reason: string }[] }> {
  if (replies.length !== mails.length) throw new Error(`unwoken: ${replies.length} mail replies for ${mails.length} managers`);
  const cancelled: { runId: string; reason: string }[] = [];
  for (const [index, mail] of mails.entries()) {
    const reply = Mailed(replies[index]!.reply);
    if (reply instanceof type.errors) throw new Error(`unwoken: ${reply.summary}`);
    if (reply.mailed) continue;
    await endRun(ctx, mail.tenantId, mail.to);
    cancelled.push({ runId: mail.to, reason: typeof reply.error === "string" ? reply.error : JSON.stringify(reply.error) });
  }
  return { cancelled };
}
