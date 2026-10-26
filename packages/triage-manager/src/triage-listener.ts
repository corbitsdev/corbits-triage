import { action, defineWorkflow, map, onTrigger, step } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { judgeAgent } from "@corbits/triage-workflows/agents";
import { HUB_WRITE } from "./actions/hub.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";

/**
 * A workspace's listener for one host under `id`, its mail address, which the hub mails the pull requests it records:
 * it deploys each one's manager from the host's published release and wakes it. It writes nothing to the pull request and holds
 * no grant on its state; a manager whose take finds another live one stops itself.
 */
export function triageListener({ id }: { id: string }) {
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
      mail: map({ over: { from: "steps.forward.output.mails" }, step: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: false }), input: { from: "trigger.payload" } }), after: ["forward"] }),
    },
  });
  return defineWorkflow({
    id,
    grantRequirements: [
      { resource: "workflow:*", action: "create", source: "creator" },
      // The manager is deployed from whichever asset the release publishes.
      { resource: "asset:*", action: "read", source: "creator" },
    ],
    mailAccept: TRIAGE_MAIL_ACCEPT,
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}
