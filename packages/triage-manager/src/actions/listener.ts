import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { isFromTriageSender, repoSourceOf, TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import { Mailed, MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, endRun, mailOf, manageMail } from "./hub.js";

/** How long a just-deployed manager has to reach a sidecar before its first mail fails. */
const MANAGER_READY_MS = 2 * 60_000;

/** The hub's mail to a listener: the repository and, as a reconciler's mail does, the heads it names as `items`. */
const ListenerMail = type({
  tenantId: "string > 0",
  repo: "string > 0",
  "repoSource?": "string",
  "prNumber?": "number.integer > 0",
  "items?": type({ prNumber: "number.integer > 0" }).array(),
});

/**
 * Deploys a manager from the host's published release for each pull request the hub's mail names, and wakes it; the
 * manager reads what to do from the hub. Only the hub's mail moves the listener; a mail that names no pull request, or a
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
    mails.push({ tenantId: mail.tenantId, to: runId, content: manageMail(mail.tenantId, pullRequest), readyBy: new Date(Date.now() + MANAGER_READY_MS).toISOString() });
  }
  return { mails };
}

const UnwokenInput = type({ forward: { output: { mails: MailInput.array() } }, mail: { output: type({ reply: "string" }).array() } });

/**
 * Cancels each manager this body deployed whose wake mail did not go, through the stock stop-run route, so a manager
 * that was never woken does not stay deployed; the output names each with why its mail failed. The pull request's next
 * event, or the reconciler re-queuing its head, deploys a fresh one.
 */
export async function unwoken(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ cancelled: { runId: string; reason: string }[] }> {
  const parsed = UnwokenInput(input);
  if (parsed instanceof type.errors) throw new Error(`unwoken: ${parsed.summary}`);
  const { mails } = parsed.forward.output;
  const replies = parsed.mail.output;
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
