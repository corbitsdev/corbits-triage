import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { isFromTriageSender, repoSourceOf, TRIAGE_LISTENERS } from "@corbits/triage-contracts";
import type { MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, mailOf, manageMail, noteDeployed } from "./hub.js";

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
 * run it deployed, and wakes it at once: stock holds mail to a run until its deploy is recorded. Only the hub's mail
 * moves the listener; a mail that names no pull request, or a listener published without a manager, fails the body.
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
    mails.push({ tenantId: mail.tenantId, to: runId, content: manageMail(mail.tenantId, pullRequest) });
  }
  return { mails };
}
