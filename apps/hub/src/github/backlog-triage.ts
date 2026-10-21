// Triages every open pull request of a repository again, at a maintainer's request or when a push leaves a valid
// policy file: the hub mails pr-triage-historical the same payload it mails pr-triage, as the tenant's triage sender.
import { type } from "arktype";
import { errorText } from "@corbits/common";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { mailPayload } from "./bridge.js";
import type { PolicyReader } from "./check-pack-store.js";
import { DeploymentNotReadyError, NoLiveDeploymentError } from "./deployment.js";
import { failure, type PortalCredentialDeps } from "./portal-credential.js";
import { grantedTriageRecord, triageInputs } from "./pr-triage.js";
import { sourceOf, type RepoRecord } from "./tenant-config.js";
import type { Member } from "../integrations/app.js";

export const BacklogBody = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

export type BacklogStartDeps = {
  readCheckPack: PolicyReader;
  sendMail: (tenantId: string, payload: unknown) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

export type GithubBacklogDeps = PortalCredentialDeps & BacklogStartDeps;

export type BacklogStart = (tenantId: string, record: RepoRecord) => Promise<Response>;

export function createBacklogStart(deps: BacklogStartDeps): BacklogStart {
  return async function startBacklog(tenantId, record) {
    const repo = record.name;
    // pr-triage-historical binds the GitHub App only.
    if (sourceOf(record) !== "github") return failure(409, "backlog_unsupported", `${repo} is not on GitHub; its open pull requests are triaged by the reconciler instead.`);
    const inputs = await triageInputs(deps, tenantId, record);
    if (inputs instanceof Response) return inputs;
    try {
      await deps.sendMail(tenantId, { ...mailPayload(record, inputs.policy, inputs.pack, {}), kind: "backlog" });
    } catch (err) {
      if (err instanceof DeploymentNotReadyError) return failure(409, err.code, err.message);
      if (err instanceof NoLiveDeploymentError || isRunTriggerUnroutable(err)) return failure(503, "service_not_running", "The pr-triage-historical service is not running.");
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
