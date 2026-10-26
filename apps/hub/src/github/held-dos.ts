// Approves a Do a triage run held, or one it failed or could not run
// unattended. The hub checks the clicker holds the Do kind's grant and mails the
// deployment of the workflow that held it, pr-triage or a PR workflow variant, the Do as the run's verdict recorded it, with who
// approved it; the run writes it at most once under its effect id.
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { ACTION_KINDS, AGENT_DO, APPROVE_DO_KIND, DoList, repoPolicy, type ActionKind, type ResolvedTarget } from "@corbits/triage-contracts";
import { schema } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunReader } from "@intx/hub-sessions";
import { errorText } from "@corbits/common";
import { doEffectId } from "@corbits/triage-workflows/logic/actions";
import { unrunnable } from "@corbits/triage-workflows/logic/execute-do";
import { doRefused, failure, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import type { PullRequestRef } from "../manager-state.js";
import type { VerdictRecordStore } from "./verdict-record-store.js";
import { DeploymentNotReadyError, newestLive, type LiveDeployment } from "./deployment.js";
import { prWorkflowVariantOf } from "./pr-workflow.js";
import { triageWorkflowFor } from "./source-workflow.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";
import { verdictFor } from "./triage-runs.js";

export const GITHUB_HELD_DOS_PATH = "/api/integrations/github-held-dos";

export const HeldDoBody = type({ runId: "string > 0", repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0", effectId: "string > 0", kind: type.enumerated(...ACTION_KINDS, "agent") });
/** `warning` says when the approved Do runs against its verdict, as a merge on a Fail or Unsure list does. */
export const HeldDoSent = type({ status: "'sent'", "warning?": "string" });

const StepBase = type({
  list: DoList,
  index: "number.integer >= 0",
  kind: type.enumerated(...ACTION_KINDS),
  effectId: "string",
  target: "object",
});
/** Held, or unattended and failed or not run: a done or satisfied Do has nothing left to approve. */
const HeldStep = StepBase.and({ held: "true", "status?": "'failed' | 'skipped'" }).or(StepBase.and({ status: "'failed' | 'skipped'" }));

const MirrorRequest = type({ repo: "string", number: "number", labels: "string[]", owned: "string[]", comment: "string" });

export type GithubHeldDosDeps = PortalCredentialDeps & {
  runReader: Pick<WorkflowRunReader, "readRunEvents">;
  verdicts: Pick<VerdictRecordStore, "forPull">;
  liveDeployments: (tenantId: string, workflow: string) => Promise<LiveDeployment[]>;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  /** Hands the approval to the workspace's listener, whose manager runs it; false when the workspace has none. */
  toListener: (tenantId: string, payload: unknown) => Promise<boolean>;
  /** The mirror request a manager's pass kept with the verdict it posted on the head. */
  passRequest: (tenantId: string, pr: PullRequestRef, runId: string, head: string) => Promise<Record<string, unknown> | undefined>;
  log: (entry: Record<string, unknown>) => void;
};

type Body = typeof HeldDoBody.infer;
type Approval = {
  kind: typeof APPROVE_DO_KIND;
  runId: string;
  principalId: string;
  list: typeof DoList.infer;
  index: number;
  request: typeof MirrorRequest.infer;
  step: { effectId: string; headSha: string; kind: ActionKind; target: ResolvedTarget };
};

/** The held Do as the verdict recorded it, with its effect id checked against the one the hub computes. */
function heldDo(verdict: Record<string, unknown>, body: Body, principalId: string): Approval | Response {
  const actions = Array.isArray(verdict["actions"]) ? (verdict["actions"] as Array<Record<string, unknown>>) : [];
  const raw = actions.find((a) => a["effectId"] === body.effectId);
  if (!raw) return failure(404, "do_not_found", "The verdict has no such Do.");
  const step = HeldStep(raw);
  if (step instanceof type.errors) return failure(409, "do_not_held", "This Do is not waiting for approval.");
  if (step.kind !== body.kind) return failure(409, "kind_mismatch", "The Do is not of the kind named.");
  const request = MirrorRequest(verdict["request"]);
  const headSha = verdict["headSha"];
  if (request instanceof type.errors || typeof headSha !== "string") return failure(409, "verdict_outdated", "Run triage again.");
  const target = step.target as ResolvedTarget;
  const effectId = doEffectId({ repo: body.repo, number: body.number, headSha, list: step.list, index: step.index, kind: step.kind, target });
  if (effectId !== step.effectId) return failure(409, "effect_mismatch", "The verdict's effect id does not match this Do.");
  const { list, index, kind } = step;
  const refused = unrunnable({ kind, target });
  if (refused) return failure(409, "do_not_runnable", refused);
  return { kind: APPROVE_DO_KIND, runId: body.runId, principalId, list, index, request, step: { effectId, headSha, kind, target } };
}

/** The run that held the Do has no workflow definition, which every run has: the store is broken, so trying again cannot help. */
class RunWithoutDefinitionError extends Error {}

export function createGithubHeldDos(deps: GithubHeldDosDeps) {
  async function runEvents(tenantId: string, domain: string, runId: string) {
    const run = await deps.db.query.workflowRun.findFirst({
      where: and(eq(schema.workflowRun.id, runId), eq(schema.workflowRun.tenantId, tenantId)),
      columns: { anchorRunId: true },
    });
    if (!run?.anchorRunId) return undefined;
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(run.anchorRunId, domain));
    return { anchorRunId: run.anchorRunId, events: await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId) };
  }

  /**
   * The workflow whose deployment held the Do: a worker is its listener's copy, so it goes by the listener's name. The
   * anchor run was just read from the run that held it, and every run has a definition, so a missing one is a broken store.
   */
  async function heldBy(tenantId: string, anchorRunId: string): Promise<string> {
    const { workflowRun, workflowDefinition } = schema;
    const [row] = await deps.db
      .select({ name: workflowDefinition.name })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .where(and(eq(workflowRun.id, anchorRunId), eq(workflowRun.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new RunWithoutDefinitionError(`run ${anchorRunId} has no workflow definition`);
    return row.name;
  }

  /** An approval stands only on the newest verdict that judged something; a run not recorded yet has none newer that is known. */
  async function superseded(tenantId: string, repo: string, number: number, runId: string): Promise<boolean> {
    const verdicts = await deps.verdicts.forPull(tenantId, repo, number);
    const at = verdicts.findIndex((verdict) => verdict.runId === runId);
    return at >= 0 && verdicts.slice(at + 1).some((verdict) => verdict.degraded === null && (verdict.runStatus === null || verdict.runStatus === "completed"));
  }

  /**
   * A manager reports its verdict when its pass is done, so its Dos are the recorded verdict's, with the mirror request
   * the pass kept. A run's newest verdict replaces its earlier one, so a Do the row no longer holds was on a verdict a
   * newer one superseded.
   */
  async function managedVerdict(tenantId: string, record: RepoRecord, { number, runId, effectId }: Body): Promise<Record<string, unknown> | Response | undefined> {
    const recorded = (await deps.verdicts.forPull(tenantId, record.name, number)).findLast((verdict) => verdict.runId === runId);
    if (!recorded?.detail) return undefined;
    if (!recorded.detail.actions?.some((action) => action.effectId === effectId)) return failure(409, "verdict_superseded", "A newer triage result exists.");
    const request = await deps.passRequest(tenantId, { source: sourceOf(record), repo: record.name, number }, runId, recorded.headSha);
    return request && { headSha: recorded.detail.headSha, actions: recorded.detail.actions, request };
  }

  return async function approve(body: typeof HeldDoBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    // A verdict recorded before agent Dos were removed may still hold one.
    if (body.kind === "agent") return failure(409, "do_not_runnable", AGENT_DO);
    const refused = await doRefused(deps, principalId, tenantId, body.repo, body.kind);
    if (refused) return refused;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const { repo, number, runId } = body;
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
    if (!record || !repoPolicy(record).enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");

    const run = await runEvents(tenantId, tenant.domain, runId);
    const events = run?.events;
    if (!run || !events?.length) return failure(404, "run_not_found", "No such run in this workspace.");
    const verdict = verdictFor(events, repo, number) ?? (await managedVerdict(tenantId, record, body));
    if (verdict instanceof Response) return verdict;
    if (!verdict) return failure(404, "verdict_not_found", `The run has no verdict for ${repo}#${number}.`);
    const approval = heldDo(verdict, body, principalId);
    if (approval instanceof Response) return approval;
    if (await superseded(tenantId, repo, number, runId)) return failure(409, "verdict_superseded", "A newer triage result exists.");
    const repoSource = sourceOf(record);
    const mailed = { ...approval, ...(repoSource !== "github" && { repoSource }) };
    const logged = { tenantId, principalId, runId, repo, number, effectId: body.effectId, kind: approval.step.kind, list: approval.list };
    // A held merge on a Fail or Unsure list may still be approved, and the person approving it is told so.
    const warning = approval.step.kind === "merge" && approval.list !== "pass" ? `The verdict on this head was ${approval.list}, not pass.` : undefined;
    try {
      if (!(await deps.toListener(tenantId, mailed))) {
        const variant = prWorkflowVariantOf(await heldBy(tenantId, run.anchorRunId));
        const heldByVariant = variant?.source === repoSource;
        const workflow = heldByVariant ? variant.id : triageWorkflowFor(repoSource).id;
        const deployment = newestLive(await deps.liveDeployments(tenantId, workflow));
        if (!deployment && heldByVariant) {
          return failure(503, "service_not_running", "Code review held this action, and it is not running now, so the action can't be approved. It runs again once the repository's policy turns a check on, the Anthropic key is saved and code review has a place to run.");
        }
        if (!deployment) return failure(503, "service_not_running", `The ${workflow} service is not running.`);
        await deps.deliver(tenantId, deployment.address, mailed);
      }
    } catch (err) {
      deps.log({ level: "error", msg: "held_do_approval_failed", ...logged, error: String(err) });
      if (err instanceof DeploymentNotReadyError) return failure(409, err.code, err.message);
      if (err instanceof RunWithoutDefinitionError) return failure(500, "run_without_definition", `Could not send the approval: ${err.message}.`);
      const unroutable = isRunTriggerUnroutable(err);
      return failure(unroutable ? 503 : 502, unroutable ? "service_not_running" : "hub_unavailable", `Could not send the approval: ${errorText(err)}. Try again.`);
    }
    deps.log({ level: "info", msg: "held_do_approved", ...logged });
    return Response.json({ status: "sent", ...(warning && { warning }) }, { status: 202 });
  };
}
