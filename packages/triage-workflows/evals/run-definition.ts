import type { WorkflowAuthorizeFn } from "@intx/workflow";
import type { Verdict } from "../src/logic/render.js";
import { recordingGithub, runLocalWorkflow, type Definition, type RunLocalInput, type Write } from "../src/run-local.js";

const INFERENCE_CREDENTIAL = "system-one";

export interface Endpoint {
  kind: "custom";
  url: string;
  model: string;
}

interface RunDefinitionInput {
  definition: Definition;
  /** GitHub's reads; writes are recorded and answered here, never passed on. */
  fetch: (url: URL, init?: RequestInit) => Promise<Response>;
  apiKey: string;
  endpoint: Endpoint;
  triggerPayload: unknown;
  onEvent?: RunLocalInput["onEvent"];
  onStepDone?: RunLocalInput["onStepDone"];
}

const logged = new Set<string>();

/**
 * Logs each distinct request once per process and allows it. The tools ask for bare `tool:<name>` resources that only
 * the sidecar's tool floor grants, and @intx/workflow-host does not export it.
 */
const loggedAuthorize: WorkflowAuthorizeFn = async function loggedAuthorize(resource, action) {
  const line = `authorize ${action} ${resource}`;
  if (!logged.has(line)) {
    logged.add(line);
    console.error(line);
  }
  return { effect: "allow", matchingGrants: [], resolvedBy: null };
};

/**
 * Runs the deployed definition's body locally: GitHub is `fetch`, and the judge calls `endpoint`. Returns what evaluate
 * decided and every GitHub write the execute and mirror steps made.
 */
export async function runDefinition({ definition, fetch, apiKey, endpoint, triggerPayload, onEvent, onStepDone }: RunDefinitionInput) {
  const writes: Write[] = [];
  const origin = new URL(endpoint.url).origin;
  const run = await runLocalWorkflow({
    ...definition,
    authorize: loggedAuthorize,
    github: recordingGithub(fetch, writes),
    inference: { credentialId: INFERENCE_CREDENTIAL, origin, apiKey },
    sourceFor: () => ({ id: INFERENCE_CREDENTIAL, provider: "corbits-system-one", baseURL: origin, credentialId: INFERENCE_CREDENTIAL, model: endpoint.model, quirks: { endpoint } }),
    triggerPayload,
    ...(onEvent && { onEvent }),
    ...(onStepDone && { onStepDone }),
  });
  const verdict = (run.outputs["evaluate"] ?? run.outputs["evaluateRules"]) as Verdict | undefined;
  if (!verdict) throw new Error(`${definition.workflow.id} ended ${run.terminalStatus} before evaluate`);
  return { terminalStatus: run.terminalStatus, verdict, writes };
}
