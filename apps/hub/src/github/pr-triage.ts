// Queues one open pull request's head on the live pr-triage deployment at a
// maintainer's request. The row is marked queued before the mail goes out so
// repeated clicks and reconcile passes see it; a failed mail puts it back.
// Attempts are left alone: a head the hub gave up on is only ever retried here.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { repoPolicy } from "@corbits/triage-contracts";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { isStuck, runKey, type ReconcilePolicy } from "./reconcile-plan.js";
import { readJson } from "../read-json.js";
import { repoRecords, triageNs } from "./tenant-config.js";
import type { PullHeadReader } from "./tenant-open-heads.js";
import { DeploymentNotReadyError, newestLive, type LiveDeployment } from "./deployment.js";
import { mergeObservedRuns, observeDeployments, type ObserveRuns } from "./triage-runs.js";
import { isQueuedSince, isRunningSince, queueHead, restoreHead } from "./triage-queue.js";
import type { TriageStateStore } from "./triage-state-store.js";

export const GITHUB_PR_TRIAGE_PATH = "/api/integrations/github-triage";

export const TriageBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" });

export type GithubPrTriageDeps = PortalCredentialDeps & {
  pullHead: PullHeadReader;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  /** Newest first; mail goes to the first, and a head may still be running on a replaced one. */
  liveDeployments: (tenantId: string) => Promise<LiveDeployment[]>;
  observeRuns: ObserveRuns;
  store: TriageStateStore;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export function createGithubPrTriage(deps: GithubPrTriageDeps) {
  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const body = TriageBody(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const { repo, number } = body;
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
    const policy = repoPolicy(record);
    if (!policy.enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");
    const pack = await deps.readCheckPack(tenantId, repo);
    if (pack.status === "corrupt") return failure(409, "check_pack_unreadable", "This repository's check pack is unreadable. Replace it on the repository page.", { reason: pack.reason });
    if (pack.status !== "ok") return failure(409, "needs_setup", "This repository still needs check setup.");
    const deployments = await deps.liveDeployments(tenantId);
    const deployment = newestLive(deployments);
    if (!deployment) return failure(503, "service_not_running", "The pr-triage service is not running.");

    let openHead: string | undefined;
    try {
      openHead = await deps.pullHead(appJson, record, number);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(502, "github_failed", `Could not read ${repo}#${number} from GitHub: ${message}.`);
    }
    if (openHead === undefined) return failure(409, "pull_request_not_open", `${repo}#${number} is not an open pull request.`);
    const headSha = openHead;

    const now = deps.now();
    const runs = mergeObservedRuns(await observeDeployments(deps.observeRuns, deployments, tenant.domain)).byRepo.get(repo)?.get(runKey(number, headSha)) ?? [];
    if (runs.some((run) => run.status === "running" && !isStuck(run, now, deps.policy))) {
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    const head = { tenantId, repo, number, headSha };
    const queued = await queueHead(deps.store, head, now, function busy(prior) {
      return isQueuedSince(prior, now, deps.policy) || isRunningSince(prior, now, deps.policy);
    });
    if (queued.status === "kept") {
      if (isQueuedSince(queued.prior, now, deps.policy)) return failure(409, "already_queued", `${repo}#${number} is already queued for triage.`);
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    if (queued.status === "conflict") return failure(409, "conflict", `${repo}#${number} was just updated by the hub. Try again.`);
    try {
      await deps.deliver(tenantId, deployment.address, mailPayload(repo, policy, pack.pack, { prNumber: number, headSha }));
    } catch (err) {
      deps.log({ level: "error", msg: "triage_request_failed", tenantId, repo, pr: number, headSha, error: String(err) });
      try {
        await restoreHead(deps.store, head, queued.remembered);
      } catch (restoreErr) {
        deps.log({ level: "error", msg: "triage_state_restore_failed", tenantId, repo, pr: number, headSha, error: String(restoreErr) });
      }
      if (err instanceof DeploymentNotReadyError) return failure(409, err.code, err.message);
      const reason = err instanceof Error ? err.message : String(err);
      return failure(isRunTriggerUnroutable(err) ? 503 : 502, isRunTriggerUnroutable(err) ? "service_not_running" : "hub_unavailable", `Could not queue ${repo}#${number}: ${reason}. Try again.`);
    }
    deps.log({ level: "info", msg: "triage_requested", tenantId, principalId, repo, pr: number, headSha });
    return Response.json({ status: "queued", headSha }, { status: 202 });
  };
}
