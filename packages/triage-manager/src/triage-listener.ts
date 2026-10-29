import { action, defineWorkflow, map, onTrigger, step } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_DEPLOYED_ACTION, MANAGER_STATE_RESOURCE, TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { judgeAgent } from "@corbits/triage-workflows/agents";
import { HUB_WRITE } from "./actions/hub.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";
import { deployGrants, type Release } from "./release.js";

/**
 * A workspace's listener for one host under `id`, its mail address, which the hub mails the pull requests it records:
 * it deploys each one's manager from the host's published release, names it to the hub and wakes it. Stock holds the
 * wake mail until the manager's deploy is recorded; a manager that never comes up loses its pull request once the hub's
 * start grace lapses, and its next event or the reconciler asks again. With `manager`, the release published as the definition loads, it declares the
 * grants to deploy that asset and to name the manager it deployed; without, none, and its body fails. It writes nothing
 * to the pull request and holds no other grant on its state; a manager whose take finds another live one stops itself.
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
    },
  });
  return defineWorkflow({
    id,
    grantRequirements: manager ? [...deployGrants(manager), { resource: MANAGER_STATE_RESOURCE, action: MANAGER_DEPLOYED_ACTION, source: "creator" as const }] : [],
    mailAccept: TRIAGE_MAIL_ACCEPT,
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}
