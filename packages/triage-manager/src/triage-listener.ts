import { action, defineWorkflow, map, onTrigger, step } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { judgeAgent } from "@corbits/triage-workflows/agents";
import { HUB_WRITE } from "./actions/hub.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";
import type { Release } from "./release.js";

/**
 * A workspace's listener for one host under `id`, its mail address, which the hub mails the pull requests it records:
 * it deploys each one's manager from the release `manager` and wakes it. It writes nothing to the pull request and holds
 * no grant on its state; a manager whose take finds another live one stops itself.
 */
export function triageListener({ id, manager }: { id: string; manager: Release }) {
  const perMail = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      forward: action({
        handler: "forward",
        input: { merge: [{ literal: { release: manager } }, { project: { from: "trigger" }, fields: ["payload"] }] },
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
      { resource: `asset:${manager.workflow.assetId}`, action: "read", source: "creator" },
    ],
    mailAccept: TRIAGE_MAIL_ACCEPT,
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}
