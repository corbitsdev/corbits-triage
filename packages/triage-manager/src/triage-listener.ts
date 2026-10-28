import { action, defineWorkflow, map, onTrigger, step } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { judgeAgent } from "@corbits/triage-workflows/agents";
import { HUB_WRITE } from "./actions/hub.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";
import { deployGrants, type Release } from "./release.js";

/**
 * A workspace's listener for one host under `id`, its mail address, which the hub mails the pull requests it records:
 * it deploys each one's manager from the host's published release and wakes it, and cancels a manager whose wake mail
 * did not go, so it is not left deployed, then deploys and wakes one more for that pull request, cancelled in turn if
 * its mail fails too. With `manager`, the release published as the definition loads, it declares the
 * grants to deploy that asset; without, none, and its body fails. It writes nothing to the pull request and holds no
 * grant on its state; a manager whose take finds another live one stops itself.
 */
export function triageListener({ id, manager }: { id: string; manager: Release | undefined }) {
  const perMail = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      forward: action({
        handler: "forward",
        input: { from: "trigger.payload" },
        credentials: [HUB_CREDENTIAL_HANDLE],
        effect: { requires: [HUB_WRITE] },
      }),
      mail: map({ over: { from: "steps.forward.output.mails" }, step: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: true }), input: { from: "trigger.payload" } }), after: ["forward"] }),
      unwoken: action({
        handler: "unwoken",
        input: { project: { from: "steps" }, fields: ["forward", "mail"] },
        after: ["mail"],
        credentials: [HUB_CREDENTIAL_HANDLE],
        effect: { requires: [HUB_WRITE] },
      }),
      retry: action({
        handler: "retry",
        input: { project: { from: "steps" }, fields: ["forward", "unwoken"] },
        after: ["unwoken"],
        credentials: [HUB_CREDENTIAL_HANDLE],
        effect: { requires: [HUB_WRITE] },
      }),
      remail: map({ over: { from: "steps.retry.output.mails" }, step: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: true }), input: { from: "trigger.payload" } }), after: ["retry"] }),
      unwokenAgain: action({
        handler: "unwokenAgain",
        input: { project: { from: "steps" }, fields: ["retry", "remail"] },
        after: ["remail"],
        credentials: [HUB_CREDENTIAL_HANDLE],
        effect: { requires: [HUB_WRITE] },
      }),
    },
  });
  return defineWorkflow({
    id,
    grantRequirements: manager ? deployGrants(manager) : [],
    mailAccept: TRIAGE_MAIL_ACCEPT,
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}
