// Triages every open pull request of a repository again, at a maintainer's request or when a push leaves a valid
// policy file: the hub hands the listener a backlog mail, which stands for each open pull request that is not a draft,
// as the tenant's triage sender.
import { type } from "arktype";
import { errorText } from "@corbits/common";
import { triageStopped } from "@corbits/triage-contracts";
import { mailPayload } from "./bridge.js";
import type { PolicyReader } from "./repo-policy.js";
import { ListenerUnroutedError, NoLiveDeploymentError } from "./deployment.js";
import type { ReconcilePolicy } from "./reconcile-plan.js";
import { holdHead } from "./triage-queue.js";
import type { TriageStateStore } from "./triage-state-store.js";
import { failure, type PortalCredentialDeps } from "./portal-credential.js";
import { grantedTriageRecord, triageInputs } from "./pr-triage.js";
import { sourceOf, triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { Member } from "../integrations/app.js";

export const BacklogBody = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

export type BacklogStartDeps = {
  readCheckPack: PolicyReader;
  sendMail: (tenantId: string, payload: unknown) => Promise<void>;
  /** The repository's open pull requests and their heads, held when the listener takes no mail. */
  openHeads: (tenantId: string, record: RepoRecord) => Promise<{ number: number; headSha: string; draft: boolean }[]>;
  store: TriageStateStore;
  policy: ReconcilePolicy;
  now: () => Date;
  /** Asks the reconciler for a pass soon. */
  retry: () => void;
  log: (entry: Record<string, unknown>) => void;
};

export type GithubBacklogDeps = PortalCredentialDeps & BacklogStartDeps;

export type BacklogStart = (tenantId: string, record: RepoRecord) => Promise<Response>;

export function createBacklogStart(deps: BacklogStartDeps): BacklogStart {
  /** Each open head goes out once a listener is up, as the backlog mail would have sent it. */
  async function holdOpenHeads(tenantId: string, record: RepoRecord, err: ListenerUnroutedError): Promise<void> {
    const now = deps.now();
    for (const pull of (await deps.openHeads(tenantId, record)).filter((open) => !open.draft)) {
      await holdHead(deps.store, { tenantId, repo: triageStateKey(record), number: pull.number, headSha: pull.headSha }, err, now, deps.policy);
    }
    deps.retry();
    deps.log({ level: "info", msg: "backlog_held", tenantId, repo: record.name, error: String(err) });
  }

  return async function startBacklog(tenantId, record) {
    const repo = record.name;
    const inputs = await triageInputs(deps, tenantId, record);
    if (inputs instanceof Response) return inputs;
    try {
      await deps.sendMail(tenantId, { ...mailPayload(record, inputs.policy, inputs.pack, {}), kind: "backlog" });
    } catch (err) {
      if (err instanceof ListenerUnroutedError) {
        await holdOpenHeads(tenantId, record, err);
        return Response.json({ status: "started" }, { status: 202 });
      }
      if (err instanceof NoLiveDeploymentError) return failure(503, "service_not_running", triageStopped(sourceOf(record)));
      deps.log({ level: "error", msg: "backlog_request_failed", tenantId, repo, error: String(err) });
      return failure(502, "hub_unavailable", `Could not start triage of ${repo}: ${errorText(err)}. Try again.`);
    }
    return Response.json({ status: "started" }, { status: 202 });
  };
}

export function createGithubBacklog(deps: GithubBacklogDeps) {
  const startBacklog = createBacklogStart(deps);
  return async function handle({ repo }: typeof BacklogBody.infer, member: Member): Promise<Response> {
    const granted = await grantedTriageRecord(deps, member, repo, undefined);
    if (granted instanceof Response) return granted;
    const started = await startBacklog(member.tenantId, granted.record);
    if (started.ok) deps.log({ level: "info", msg: "backlog_requested", tenantId: member.tenantId, principalId: member.principalId, repo });
    return started;
  };
}
