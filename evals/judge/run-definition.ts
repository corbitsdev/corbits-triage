import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowDirectorRegistry } from "@intx/agent";
import { evaluateGrants } from "@intx/authz";
import { buildCredentialCapabilities, createCredentialProviderRegistry, createHttpCredentialProvider, createInferenceCredentialResolver } from "@intx/harness";
import { createDependencies } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import { createIsogitStore } from "@intx/storage-isogit/node";
import type { GrantRule } from "@intx/types/authz";
import type { CredentialDelivery } from "@intx/types/credential-delivery";
import { createRuntimeCapabilities } from "@intx/types/runtime-capabilities";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvokeRequest, type WorkflowAuthorizeFn } from "@intx/workflow";
import { createWorkflowStepInvoker } from "@intx/workflow-host";
import * as actions from "../../packages/triage-workflows/src/actions/index.js";
import { credentialBindings, grantRequirements } from "../../packages/triage-workflows/src/agents.js";
import { triageDirector } from "../../packages/triage-workflows/src/directors.js";
import type { Verdict } from "../../packages/triage-workflows/src/logic/render.js";
import { workflow } from "../../packages/triage-workflows/src/pr-triage.js";

const GITHUB_ORIGIN = "https://api.github.com";
const INFERENCE_CREDENTIAL = "system-one";

export interface Endpoint {
  kind: "custom";
  url: string;
  model: string;
}

export interface RunDefinitionInput {
  /** GitHub's reads; writes are recorded and answered here, never passed on. */
  fetch: (url: URL) => Promise<Response>;
  apiKey: string;
  endpoint: Endpoint;
  triggerPayload: unknown;
  /** The library's GitHub definition unless a deployed package's is given. */
  definition?: typeof workflow;
}

export type Write = { method: string; path: string; body: unknown };

/** The creator grants the definition asks for, as the hub stamps them on a run. */
const GRANTS: GrantRule[] = grantRequirements.map((rule, index) => ({
  id: `grant-${index}`,
  resource: rule.resource,
  action: rule.action,
  effect: "allow",
  origin: "creator",
  conditions: "conditions" in rule ? rule.conditions : null,
  expiresAt: null,
  roleId: null,
  principalId: null,
}));

const logged = new Set<string>();

/**
 * Logs each distinct decision the definition's grants make, once per process, and allows the call. The tools ask for
 * bare `tool:<name>` resources that only the sidecar's tool floor grants, and @intx/workflow-host does not export it.
 */
const loggedAuthorize: WorkflowAuthorizeFn = async function loggedAuthorize(resource, action) {
  const { effect } = await evaluateGrants(GRANTS, resource, action);
  const line = `authorize ${action} ${resource}: ${effect ?? "no grant"}`;
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

function resolveAction(ref: string): ActionHandler {
  const handler = (actions as Record<string, ActionHandler>)[ref];
  if (!handler) throw new Error(`no action handler ${ref}`);
  return handler;
}

/**
 * Runs the deployed pr-triage body through Interchange's local runner with the production step invoker, agents and
 * directors: GitHub is `fetch`, and the judge calls `endpoint`. Returns what evaluate decided and every GitHub write the
 * execute and mirror steps made.
 */
export async function runDefinition({ fetch, apiKey, endpoint, triggerPayload, definition = workflow }: RunDefinitionInput) {
  const writes: Write[] = [];
  const origin = new URL(endpoint.url).origin;
  const cell: { current: CredentialDelivery } = {
    current: {
      bindings: credentialBindings.map((binding) => ({ handle: binding.handle, credentialId: "github", consumer: `tool:${binding.package}` })),
      materials: [
        { credentialId: "github", providerKey: "http", origin: GITHUB_ORIGIN, secret: "local" },
        { credentialId: INFERENCE_CREDENTIAL, providerKey: "http", origin, secret: apiKey },
      ],
    },
  };
  const providers = createCredentialProviderRegistry([createHttpCredentialProvider({ fetch: recordingGithub(fetch, writes) })]);
  const adapters = await loadAdapterRegistry([{ provider: "corbits-system-one", specifier: "@corbits/system-one", export: "createSystemOneAdapterFactory" }]);
  const directors = createWorkflowDirectorRegistry([triageDirector.factory]);
  const root = mkdtempSync(join(tmpdir(), "triage-run-"));

  /** What the sidecar gives a step, less the mail transport triage never uses. */
  async function buildEnv(req: StepInvokeRequest) {
    const workdir = mkdtempSync(join(root, "step-"));
    const storage = await createIsogitStore(workdir);
    const factories = req.agent.toolFactories.map((factory) => ({ packageName: factory.id, declaredCredentials: [], factory }));
    const credentials = [...buildCredentialCapabilities(factories, { materialCell: cell, resolveGrants: () => GRANTS, providers }).values()];
    // The sidecar layers one capability bag per tool bundle; a step env holds one, which serves an agent with one package.
    if (credentials.length > 1) throw new Error(`${req.agent.id} carries ${credentials.length} credentialed tool packages; a local step serves one`);
    return {
      sources: [{ id: INFERENCE_CREDENTIAL, provider: "corbits-system-one", baseURL: origin, credentialId: INFERENCE_CREDENTIAL, model: endpoint.model, quirks: { endpoint } }],
      defaultSource: INFERENCE_CREDENTIAL,
      storage,
      audit: storage,
      workdir,
      directors,
      deps: createDependencies(adapters),
      readCurrentMaterial: createInferenceCredentialResolver(cell),
      capabilities: createRuntimeCapabilities(credentials[0] ? { credentials: credentials[0] } : {}),
    };
  }

  const body = (definition.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the pr-triage body is not inline");
  try {
    const run = await runLocal(body.inline, {
      authorize: loggedAuthorize,
      directors,
      hasUpstreamSignalResolver: true,
      invokeStep: createWorkflowStepInvoker({ workflowAuthorize: loggedAuthorize, buildEnv }),
      actionResolver: resolveAction,
      triggerPayload,
    }).complete;
    const verdict = (run.outputs["evaluate"] ?? run.outputs["evaluateRules"]) as Verdict | undefined;
    if (!verdict) throw new Error(`pr-triage ended ${run.terminalStatus} before evaluate`);
    return { terminalStatus: run.terminalStatus, verdict, writes };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
