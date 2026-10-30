// Approves a Do a triage run held, or one it failed or could not run
// unattended. The hub checks the clicker holds the Do kind's grant and hands the
// host's listener the Do as the run's verdict recorded it, with who approved it;
// the pull request's manager writes it at most once under its effect id.
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { ACTION_KINDS, AGENT_DO, APPROVE_DO_KIND, DoList, REPO_SOURCES, repoPolicy, repoSourceOf, triageStopped, type ActionKind, type RepoSource, type ResolvedTarget } from "@corbits/triage-contracts";
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
import { ListenerUnroutedError, workflowName } from "./deployment.js";
import type { ReconcilePolicy } from "./reconcile-plan.js";
import { holdHead } from "./triage-queue.js";
import type { TriageStateStore } from "./triage-state-store.js";
import { repoRecords, sourceOf, triageNs, triageStateKey, type RepoRecord } from "./tenant-config.js";
import { verdictFor } from "./triage-runs.js";
import { verdictWorkflowsFor } from "./source-workflow.js";

export const GITHUB_HELD_DOS_PATH = "/api/integrations/github-held-dos";

export const HeldDoBody = type({ runId: "string > 0", repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0", effectId: "string > 0", kind: type.enumerated(...ACTION_KINDS, "agent"), "source?": type.enumerated(...REPO_SOURCES) });
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
  verdicts: Pick<VerdictRecordStore, "forPull" | "forHostedPull">;
  /** Hands the approval to the workspace's listener, whose manager runs it; false when the workspace has none. */
  toListener: (tenantId: string, payload: unknown) => Promise<boolean>;
  /** The mirror request a manager's pass kept with the verdict it posted on the head. */
  passRequest: (tenantId: string, pr: PullRequestRef, runId: string, head: string) => Promise<Record<string, unknown> | undefined>;
  /** Holds the head of an approval its listener took no mail for, which the reconciler mails once one is up. */
  store: TriageStateStore;
  policy: ReconcilePolicy;
  now: () => Date;
  /** Asks the reconciler for a pass soon. */
  retry: () => void;
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

/** A workflow `verdictWorkflowsFor` names for Bitbucket is that host's; every other name, and a missing one, is GitHub's. */
function hostOfWorkflow(name: string | null): RepoSource {
  return name !== null && verdictWorkflowsFor("bitbucket-datacenter").includes(name) ? "bitbucket-datacenter" : "github";
}

export function createGithubHeldDos(deps: GithubHeldDosDeps) {
  async function runEvents(tenantId: string, domain: string, runId: string) {
    const [run] = await deps.db
      .select({ anchorRunId: schema.workflowRun.anchorRunId, workflow: workflowName })
      .from(schema.workflowRun)
      .leftJoin(schema.workflowDefinition, eq(schema.workflowDefinition.id, schema.workflowRun.definitionId))
      .leftJoin(schema.workflowRunLaunchSpec, eq(schema.workflowRunLaunchSpec.anchorRunId, schema.workflowRun.anchorRunId))
      .where(and(eq(schema.workflowRun.id, runId), eq(schema.workflowRun.tenantId, tenantId)));
    if (!run?.anchorRunId) return undefined;
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(run.anchorRunId, domain));
    return { anchorRunId: run.anchorRunId, workflow: run.workflow, events: await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId) };
  }

  /** An approval stands only on the newest verdict of its host that judged something; a run not recorded yet has none newer that is known. */
  async function superseded(tenantId: string, source: RepoSource, repo: string, number: number, runId: string): Promise<boolean> {
    const verdicts = await deps.verdicts.forHostedPull(tenantId, { source, repo, number });
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
    const source = repoSourceOf(body.source);
    const refused = await doRefused(deps, principalId, tenantId, source, body.repo, body.kind);
    if (refused) return refused;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const { repo, number, runId } = body;
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected && sourceOf(row) === source);
    if (!record || !repoPolicy(record).enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");

    const run = await runEvents(tenantId, tenant.domain, runId);
    const events = run?.events;
    if (!run || !events?.length) return failure(404, "run_not_found", "No such run in this workspace.");
    if (hostOfWorkflow(run.workflow) !== source) return failure(409, "run_host_mismatch", "This run is on another host.");
    const verdict = verdictFor(events, repo, number) ?? (await managedVerdict(tenantId, record, body));
    if (verdict instanceof Response) return verdict;
    if (!verdict) return failure(404, "verdict_not_found", `The run has no verdict for ${repo}#${number}.`);
    const approval = heldDo(verdict, body, principalId);
    if (approval instanceof Response) return approval;
    if (await superseded(tenantId, source, repo, number, runId)) return failure(409, "verdict_superseded", "A newer triage result exists.");
    const repoSource = sourceOf(record);
    const mailed = { ...approval, ...(repoSource !== "github" && { repoSource }) };
    const logged = { tenantId, principalId, runId, repo, number, effectId: body.effectId, kind: approval.step.kind, list: approval.list };
    // A held merge on a Fail or Unsure list may still be approved, and the person approving it is told so.
    const warning = approval.step.kind === "merge" && approval.list !== "pass" ? `The verdict on this head was ${approval.list}, not pass.` : undefined;
    try {
      if (!(await deps.toListener(tenantId, mailed))) return failure(503, "service_not_running", triageStopped(repoSource));
    } catch (err) {
      if (!(err instanceof ListenerUnroutedError)) {
        deps.log({ level: "error", msg: "held_do_approval_failed", ...logged, error: String(err) });
        return failure(502, "hub_unavailable", `Could not send the approval: ${errorText(err)}. Try again.`);
      }
      // The approval is recorded; the head goes out with it once a listener is up.
      await holdHead(deps.store, { tenantId, repo: triageStateKey(record), number, headSha: approval.step.headSha }, err, deps.now(), deps.policy);
      deps.retry();
      deps.log({ level: "info", msg: "held_do_approval_held", ...logged, error: String(err) });
    }
    deps.log({ level: "info", msg: "held_do_approved", ...logged });
    return Response.json({ status: "sent", ...(warning && { warning }) }, { status: 202 });
  };
}
