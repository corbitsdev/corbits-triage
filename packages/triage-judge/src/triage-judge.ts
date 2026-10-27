import { action, defineWorkflow, map, onTrigger, SELF_RUN_RESOURCE, step, type Selector } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE } from "@corbits/triage-contracts";
import { HUB_WRITE } from "@corbits/triage-manager/actions/hub";
import { judgeAgent } from "@corbits/triage-workflows/agents";

const TIMEOUT = 15 * 60_000;
const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: TIMEOUT } as const;

/** A map's output is an array, which a merge cannot take, so it rides as `judge.output`. */
const JUDGED = { project: { from: "steps" }, fields: ["judge"] } as const;

const BOTH_JUDGED = { project: { from: "steps" }, fields: ["judge", "judgeParts"] } as const;

/** The chunks are already in the run log twice; evaluate re-derives them from the items the manager mailed. */
const RULED = { project: { from: "steps.judgeRequest.output" }, fields: ["items", "batch"] } as const;

function hubAction(handler: string, input: Selector, after: readonly string[]) {
  return action({ handler, input, after, credentials: [HUB_CREDENTIAL_HANDLE], effect: { requires: [HUB_WRITE] } });
}

/**
 * The judge a pull request's manager deploys, under `id`, also its mail address. It runs the model checks the machine
 * rules produced, reports the verdict through the hub, or that it did not finish, which wakes the pull request's
 * manager, then stops, whatever failed before. It posts nothing to the pull request. Only the manager that deployed it
 * may mail it.
 */
export function triageJudge({ id }: { id: string }) {
  const body = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      judgeRequest: action({ handler: "judgeRequest", input: { from: "trigger.payload" } }),
      judge: map({ over: { from: "steps.judgeRequest.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["judgeRequest"] }),
      parts: action({ handler: "parts", input: { merge: [RULED, JUDGED] }, after: ["judge"] }),
      judgeParts: map({ over: { from: "steps.parts.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["parts"] }),
      evaluate: action({ handler: "evaluate", input: { merge: [RULED, BOTH_JUDGED] }, after: ["judgeParts"] }),
      // Stock runs a step whose dependencies failed, so the report and the stop run however the judge ended.
      report: hubAction("report", { merge: [{ from: "steps" }, { project: { from: "trigger" }, fields: ["payload"] }] }, ["evaluate"]),
      stop: hubAction("stop", { from: "trigger.payload" }, ["report"]),
    },
  });
  return defineWorkflow({
    id,
    grantRequirements: [
      { resource: MANAGER_RESULT_RESOURCE, action: MANAGER_RESULT_ACTION, source: "creator" },
      { resource: SELF_RUN_RESOURCE, action: "manage", source: "creator" },
    ],
    mailAccept: { invoker: true },
    steps: { events: onTrigger({ on: { type: "mail", to: id }, body, onBodyFailure: "tolerate" }) },
  });
}
