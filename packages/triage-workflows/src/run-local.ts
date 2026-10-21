import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowDirectorRegistry } from "@intx/agent";
import { buildCredentialCapabilities, createCredentialProviderRegistry, createHttpCredentialProvider, createInferenceCredentialResolver } from "@intx/harness";
import { createDependencies } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import { createIsogitStore } from "@intx/storage-isogit/node";
import { createRuntimeCapabilities } from "@intx/types/runtime-capabilities";
import type { InferenceEvent } from "@intx/types/inference-events";
import { runLocal, type ActionHandler, type OnTriggerPrimitive, type StepInvokeRequest, type WorkflowAuthorizeFn, type WorkflowDefinition } from "@intx/workflow";
import { createWorkflowStepInvoker } from "@intx/workflow-host";
import { delivered, grantsFor, localActionCredentials, type Bindings, type Fetch } from "./local-credentials.js";
import * as systemOne from "@corbits/system-one";
import * as actions from "./actions/index.js";
import { credentialBindings } from "./agents.js";
import { triageJudgeDirector } from "./directors.js";
import { workflow } from "./pr-triage.js";

type Source = { id: string; provider: string; baseURL: string; credentialId: string; model: string; quirks?: Record<string, unknown> };

export interface RunLocalInput {
  workflow: WorkflowDefinition;
  /** The workflow's director factories, as its package exports them; none when every agent runs the stock director. */
  directors?: Parameters<typeof createWorkflowDirectorRegistry>[0];
  actions: Record<string, unknown>;
  credentialBindings: Bindings;
  authorize: WorkflowAuthorizeFn;
  /** GitHub's requests, reads and writes alike. */
  github: Fetch;
  /** The inference credential every source names. */
  inference: { credentialId: string; origin: string; apiKey: string };
  /** The inference source an agent's step runs on. */
  sourceFor: (req: StepInvokeRequest) => Source;
  triggerPayload: unknown;
  /** Every agent step's inference events, for usage and transcripts. */
  onEvent?: (event: InferenceEvent) => void;
  /** Each agent step's wall time, by agent id. */
  onStepDone?: (agentId: string, ms: number) => void;
  /** The run's clock, which times its retries' backoff; the wall clock when absent. */
  clock?: () => Date;
}

/** A deployed definition and what its package supplies to run it. */
export interface Definition {
  workflow: RunLocalInput["workflow"];
  directors: NonNullable<RunLocalInput["directors"]>;
  actions: RunLocalInput["actions"];
  credentialBindings: RunLocalInput["credentialBindings"];
}

export const PR_TRIAGE: Definition = { workflow, directors: [triageJudgeDirector.factory], actions, credentialBindings };

export type Write = { method: string; path: string; body: unknown };

/** GitHub served by `read` for reads; each write is recorded in `writes` and answered here, never passed on. */
export function recordingGithub(read: (url: URL, init?: RequestInit) => Promise<Response>, writes: Write[]) {
  return async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (method === "GET") return read(url, init);
    writes.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(url.pathname.endsWith("/labels") ? [] : { id: writes.length });
  };
}

/** The adapter's module from this package's own dependencies, wherever the inference package is installed. */
async function importSystemOne(): Promise<unknown> {
  return systemOne;
}

/**
 * Runs a pr-* workflow body through Interchange's local runner with the production step invoker, agents, directors and
 * action credentials. Returns the finished run; callers read the outputs they score.
 */
export async function runLocalWorkflow(input: RunLocalInput) {
  const { workflow, authorize, inference } = input;
  const grants = grantsFor(input.credentialBindings);
  const cell = delivered(input.credentialBindings, [{ credentialId: inference.credentialId, providerKey: "http", origin: inference.origin, secret: inference.apiKey }]);
  const providers = createCredentialProviderRegistry([createHttpCredentialProvider({ fetch: input.github })]);
  const adapters = await loadAdapterRegistry([{ provider: "corbits-system-one", specifier: "@corbits/system-one", export: "createSystemOneAdapterFactory" }], { import: importSystemOne });
  const directors = createWorkflowDirectorRegistry(input.directors ?? []);
  const root = mkdtempSync(join(tmpdir(), "workflow-run-"));

  /** What the sidecar gives a step, less the mail transport these workflows never use. */
  async function buildEnv(req: StepInvokeRequest) {
    const workdir = mkdtempSync(join(root, "step-"));
    const storage = await createIsogitStore(workdir);
    // A deployed step's tools work in a throwaway workspace beside its storage, never in the storage itself.
    const toolCwd = join(workdir, "workspace");
    mkdirSync(toolCwd);
    const factories = req.agent.toolFactories.map((factory) => ({ packageName: factory.id, declaredCredentials: [], factory }));
    const credentials = [...buildCredentialCapabilities(factories, { materialCell: cell, resolveGrants: () => grants, providers }).values()];
    // The sidecar layers one capability bag per tool bundle; a step env holds one, which serves an agent with one package.
    if (credentials.length > 1) throw new Error(`${req.agent.id} carries ${credentials.length} credentialed tool packages; a local step serves one`);
    const source = input.sourceFor(req);
    return {
      sources: [source],
      defaultSource: source.id,
      storage,
      audit: storage,
      workdir,
      toolCwd,
      directors,
      deps: createDependencies(adapters),
      readCurrentMaterial: createInferenceCredentialResolver(cell),
      capabilities: createRuntimeCapabilities(credentials[0] ? { credentials: credentials[0] } : {}),
    };
  }

  function resolveAction(ref: string): ActionHandler {
    const handler = input.actions[ref] as ActionHandler | undefined;
    if (!handler) throw new Error(`no action handler ${ref}`);
    return handler;
  }

  const invoke = createWorkflowStepInvoker({ workflowAuthorize: authorize, buildEnv, ...(input.onEvent ? { onEvent: input.onEvent } : {}) });
  async function invokeStep(req: StepInvokeRequest) {
    const started = performance.now();
    try {
      return await invoke(req);
    } finally {
      input.onStepDone?.(req.agent.id, performance.now() - started);
    }
  }

  const body = (workflow.steps.events as OnTriggerPrimitive).body;
  if (!("inline" in body)) throw new Error("the workflow body is not inline");
  try {
    return await runLocal(body.inline, {
      authorize,
      directors,
      hasUpstreamSignalResolver: true,
      invokeStep,
      actionResolver: resolveAction,
      actionCredentials: localActionCredentials(input.credentialBindings, input.github, cell),
      triggerPayload: input.triggerPayload,
      ...(input.clock && { clock: input.clock }),
    }).complete;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
