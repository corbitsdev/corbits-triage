import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { judgeAgent } from "../packages/triage-workflows/src/agents";
import { generateKeyPair } from "../vendor/interchange/packages/crypto/src";
import { createBuiltinRegistry } from "../vendor/interchange/packages/inference/src/providers";
import { ModelProviderPlugin } from "../vendor/interchange/packages/types/src/catalog";
import { hexEncode } from "../vendor/interchange/packages/types/src/hex";
import { defineWorkflow, step } from "../vendor/interchange/packages/workflow/src";
import {
  collectDeclaredCredentialConsumers,
  collectDeclaredResources,
  filterGrantsToDeclaredResources,
} from "../vendor/interchange/packages/workflow-deploy/src/child-grant-filter";
import { createSidecarStepBuildEnv, createSidecarSubstrateFactory } from "../vendor/interchange/packages/workflow-host/src/child/substrate-factory";
import { runGrantsPath } from "../vendor/interchange/packages/workflow-host/src/run-grants";
import { loadWorkflowDirectorRegistryFromClosure } from "../vendor/interchange/packages/workflow-host/src/workflow-definition-loader";

const packageDir = resolve(import.meta.dirname, "../packages/triage-workflows");
const directorRef = { id: "@corbits/triage-workflows/judge", config: {} };

type BuildStepEnv = ReturnType<typeof createSidecarStepBuildEnv>;

test("the operator model provider key passes the vendored catalog boundary", () => {
  expect(ModelProviderPlugin("corbits-system-one")).toBe("corbits-system-one");
});

test("the stock loader resolves the repository custom director", async () => {
  const registry = await loadWorkflowDirectorRegistryFromClosure({ packageDir });

  expect(registry.resolve(directorRef).id).toBe(directorRef.id);
});

test("the step env resolves the repository custom director", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendor-health-"));
  try {
    const buildStepEnv = createSidecarStepBuildEnv({
      dataDir,
      workflowRunRepoId: { kind: "workflow-run", id: "vendor-health" },
      signer: (payload: string) => Promise.resolve(`sig:${payload.length}`),
      mailboxAddress: "run_vendor-health@example.com",
      stepCount: 1,
      outboundMailBridge: {
        submit: () => Promise.reject(new Error("unused")),
        handleResult: () => undefined,
        cancelAll: () => undefined,
        pendingCount: 0,
      },
      cache: { cacheMaxBytes: 1_000_000, registryMaxTarballBytes: 1_000_000 },
      adapters: createBuiltinRegistry(),
      recordToolMarkFloor: () => undefined,
      sourceTools: false,
      closurePackageDir: packageDir,
      materializeStepTools: () => Promise.resolve({ factories: [], pluginFactories: [] }),
    });
    const env = await buildStepEnv(
      {
        // buildEnv reads only authzContext; the agent definition is never consulted.
        agent: {} as Parameters<BuildStepEnv>[0]["agent"],
        input: null,
        authzContext: { stepId: "facts", runId: "vendor-health", attempt: 1 },
        signal: new AbortController().signal,
      },
      {
        current: {
          facts: [
            { id: "s", provider: "anthropic", baseURL: "https://api.anthropic.com", credentialId: "c", model: "m" },
          ],
        },
      },
    );

    expect(env.directors.resolve(directorRef).id).toBe(directorRef.id);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a loop iteration's grant cap keeps the repository custom director's grant", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vendor-health-"));
  try {
    const keys = await generateKeyPair();
    const createSubstrate = createSidecarSubstrateFactory({
      materializeStepTools: () => Promise.resolve({ factories: [], pluginFactories: [] }),
      collectDeclaredResources,
      collectDeclaredCredentialConsumers,
      filterGrantsToDeclaredResources,
    });
    const written: Record<string, string | Uint8Array>[] = [];
    const bindings = await createSubstrate({
      spawn: {
        channelId: "vendor-health",
        hmacKey: new Uint8Array(32),
        hostPublicKey: keys.publicKey,
        anchorRunId: "vendor-health",
        definitionHash: "vendor-health",
        mailboxAddress: "run_vendor-health@example.com",
        stepCount: 1,
        warmKeep: false,
        closurePackageDir: packageDir,
      },
      substrateConfig: {
        SIDECAR_DATA_DIR: dataDir,
        WORKFLOW_RUN_REPO_ID: "vendor-health",
        WORKFLOW_RUN_REF: "refs/heads/main",
        SIDECAR_SIGNING_PUBLIC_KEY: hexEncode(keys.publicKey),
        SIDECAR_SIGNING_PRIVATE_KEY: hexEncode(keys.privateKey),
        STEP_INFERENCE_SOURCES: "{}",
        WORKFLOW_BODY_SOURCES: "{}",
        SIDECAR_CACHE_MAX_BYTES: "1000000",
        SIDECAR_REGISTRY_MAX_TARBALL_BYTES: "1000000",
        SIDECAR_ADAPTER_MANIFEST: "[]",
      },
      substrateWriteBridge: {
        async submit(req) {
          written.push(await req.merge(new Map()));
          return { commitSha: "0".repeat(40) };
        },
        handleMergeRequest: () => undefined,
        handleWriteResponse: () => undefined,
        cancelAll: () => undefined,
        pendingCount: 0,
      },
      // A grant cap sends no mail.
      outboundMailBridge: {} as never,
      mailboxMutationBridge: {} as never,
      mailboxCallBridge: {} as never,
    });
    const directorGrant = { resource: `director:${directorRef.id}`, action: "invoke", effect: "allow", origin: "creator", conditions: null, expiresAt: null };
    const parentGrants = join(bindings.substrate.getRepoDir({ kind: "workflow-run", id: "vendor-health" }), runGrantsPath("parent"));
    await mkdir(dirname(parentGrants), { recursive: true });
    await writeFile(parentGrants, JSON.stringify({ grants: [directorGrant] }));

    await bindings.materializeLoopIterationGrants?.({
      parentRunId: "parent",
      childRunId: "child",
      definition: defineWorkflow({ id: "judge-body", trigger: { type: "manual" }, steps: { judge: step({ agent: judgeAgent }) } }),
    });

    expect(written.map((files) => JSON.parse(String(files[runGrantsPath("child")])))).toEqual([{ grants: [directorGrant] }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
