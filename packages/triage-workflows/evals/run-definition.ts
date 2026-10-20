import type { WorkflowAuthorizeFn } from "@intx/workflow";
import * as actions from "../src/actions/index.js";
import { credentialBindings } from "../src/agents.js";
import { triageJudgeDirector } from "../src/directors.js";
import type { Verdict } from "../src/logic/render.js";
import { workflow } from "../src/pr-triage.js";
import { runLocalWorkflow, type RunLocalInput } from "./run-local.js";

const INFERENCE_CREDENTIAL = "system-one";

export interface Endpoint {
  kind: "custom";
  url: string;
  model: string;
}

interface RunDefinitionInput {
  /** GitHub's reads; writes are recorded and answered here, never passed on. */
  fetch: (url: URL) => Promise<Response>;
  apiKey: string;
  endpoint: Endpoint;
  triggerPayload: unknown;
  onEvent?: RunLocalInput["onEvent"];
  onStepDone?: RunLocalInput["onStepDone"];
}

type Write = { method: string; path: string; body: unknown };

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

function recordingGithub(read: RunDefinitionInput["fetch"], writes: Write[]) {
  return async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (method === "GET") return read(url);
    writes.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(url.pathname.endsWith("/labels") ? [] : { id: writes.length });
  };
}

/**
 * Runs the deployed pr-triage body locally: GitHub is `fetch`, and the judge calls `endpoint`. Returns what evaluate
 * decided and every GitHub write the execute and mirror steps made.
 */
export async function runDefinition({ fetch, apiKey, endpoint, triggerPayload, onEvent, onStepDone }: RunDefinitionInput) {
  const writes: Write[] = [];
  const origin = new URL(endpoint.url).origin;
  const run = await runLocalWorkflow({
    workflow,
    directors: [triageJudgeDirector.factory],
    actions,
    credentialBindings,
    authorize: loggedAuthorize,
    github: recordingGithub(fetch, writes),
    inference: { credentialId: INFERENCE_CREDENTIAL, origin, apiKey },
    sourceFor: () => ({ id: INFERENCE_CREDENTIAL, provider: "corbits-system-one", baseURL: origin, credentialId: INFERENCE_CREDENTIAL, model: endpoint.model, quirks: { endpoint } }),
    triggerPayload,
    ...(onEvent && { onEvent }),
    ...(onStepDone && { onStepDone }),
  });
  const verdict = (run.outputs["evaluate"] ?? run.outputs["evaluateRules"]) as Verdict | undefined;
  if (!verdict) throw new Error(`pr-triage ended ${run.terminalStatus} before evaluate`);
  return { terminalStatus: run.terminalStatus, verdict, writes };
}
