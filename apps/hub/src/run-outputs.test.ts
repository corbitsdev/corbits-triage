import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair } from "@intx/crypto";
import { createAgentRepoStore, WORKFLOW_RUN_GITIGNORE_PATH, WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import { createWorkflowRunBlobSubstrate } from "@intx/workflow-host";
import { verdictFor } from "./github/triage-runs.js";
import { withBlobOutputs } from "./run-outputs.js";

const RUN = "run_0123456789abcdef0123456789abcdef";
const VERDICT = { repo: "acme/widgets", number: 8, headSha: "abc", actions: [], feedback: "x".repeat(200) };

async function spilled() {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-outputs-"));
  const { repoStore } = createAgentRepoStore({ dataDir: root, signingKey: await generateKeyPair() });
  const repoId = workflowRunRepoIdForAddress(formatRunAddress("wfr_anchor", "acme.test"));
  const principal = { kind: "hub" };
  const started = JSON.stringify({ seq: 0, type: "RunStarted" });
  await repoStore.writeTree(principal, repoId, WORKFLOW_RUN_REF, { files: { [WORKFLOW_RUN_GITIGNORE_PATH]: "", [`runs/${RUN}/events/0.json`]: started }, message: "start" });
  const blobs = createWorkflowRunBlobSubstrate({ substrate: repoStore, repoId, principal, runId: RUN, ref: WORKFLOW_RUN_REF, inlineMaxBytes: 64 });
  const { ref } = await blobs.recordOutput("evaluate", 1, VERDICT);
  // The hub takes a sidecar's run in as git objects only, with no files on disk.
  await rm(path.join(repoStore.getRepoDir(repoId), "runs"), { recursive: true, force: true });
  return { root, repoStore, repoId, ref };
}

function readerOf(events: WorkflowRunEvent[]): WorkflowRunReader {
  return { readRunEvents: async () => events } as unknown as WorkflowRunReader;
}

function evaluated(ref: string): WorkflowRunEvent {
  return { seq: 1, type: "StepCompleted", body: { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref } } } as WorkflowRunEvent;
}

test("a step output over the inline limit is read from the run's committed blob", async () => {
  const { root, repoStore, repoId, ref } = await spilled();
  try {
    expect(ref).toStartWith("blob:");
    const events = [evaluated(ref)];
    expect(verdictFor(events, VERDICT.repo, VERDICT.number)).toBeUndefined();
    const read = await withBlobOutputs(readerOf(events), repoStore, { error: () => {} }).readRunEvents(repoId, WORKFLOW_RUN_REF, RUN);
    expect(verdictFor(read, VERDICT.repo, VERDICT.number)).toEqual(VERDICT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a step output whose blob is not committed is logged and read as no verdict", async () => {
  const { root, repoStore, repoId } = await spilled();
  try {
    const missing = `blob:${"0".repeat(64)}`;
    const logged: unknown[] = [];
    const reader = withBlobOutputs(readerOf([evaluated(missing)]), repoStore, { error: (_message: string, properties: unknown) => logged.push(properties) });
    const read = await reader.readRunEvents(repoId, WORKFLOW_RUN_REF, RUN);
    expect(read).toEqual([evaluated(missing)]);
    expect(verdictFor(read, VERDICT.repo, VERDICT.number)).toBeUndefined();
    expect(logged).toEqual([{ ref: missing, runId: RUN }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
