import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createBuiltinRegistry } from "../vendor/interchange/packages/inference/src/providers";
import { ModelProviderPlugin } from "../vendor/interchange/packages/types/src/catalog";
import { createSidecarStepBuildEnv } from "../vendor/interchange/packages/workflow-host/src/child/substrate-factory";
import { loadWorkflowDirectorRegistryFromClosure } from "../vendor/interchange/packages/workflow-host/src/workflow-definition-loader";

const packageDir = resolve(import.meta.dirname, "../packages/triage-workflows");
const directorRef = { id: "@corbits/triage-workflows/triage", config: { role: "facts" } };

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
