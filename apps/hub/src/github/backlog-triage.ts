// Triages every open pull request of a repository again, at a maintainer's request: the hub mails pr-triage-historical
// the same payload it mails pr-triage, as the tenant's triage sender.
import { type } from "arktype";
import { errorText } from "@corbits/common";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { DeploymentNotReadyError, NoLiveDeploymentError } from "./deployment.js";
import { failure, type PortalCredentialDeps } from "./portal-credential.js";
import { readyToTriage } from "./pr-triage.js";
import { sourceOf } from "./tenant-config.js";
import type { Member } from "../integrations/app.js";

export const BacklogBody = type({ repo: /^[\w.-]+\/[\w.-]+$/ });

export type GithubBacklogDeps = PortalCredentialDeps & {
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  sendMail: (tenantId: string, payload: unknown) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

export function createGithubBacklog(deps: GithubBacklogDeps) {
  return async function handle({ repo }: typeof BacklogBody.infer, member: Member): Promise<Response> {
    const ready = await readyToTriage(deps, member, repo);
    if (ready instanceof Response) return ready;
    const { tenantId, principalId } = member;
    // pr-triage-historical binds the GitHub App only.
    if (sourceOf(ready.record) !== "github") return failure(409, "backlog_unsupported", `${repo} is not on GitHub; its open pull requests are triaged by the reconciler instead.`);
    try {
      await deps.sendMail(tenantId, { ...mailPayload(ready.record, ready.policy, ready.pack, {}), kind: "backlog" });
    } catch (err) {
      if (err instanceof DeploymentNotReadyError) return failure(409, err.code, err.message);
      if (err instanceof NoLiveDeploymentError || isRunTriggerUnroutable(err)) return failure(503, "service_not_running", "The pr-triage-historical service is not running.");
      deps.log({ level: "error", msg: "backlog_request_failed", tenantId, repo, error: String(err) });
      return failure(502, "hub_unavailable", `Could not start triage of ${repo}: ${errorText(err)}. Try again.`);
    }
    deps.log({ level: "info", msg: "backlog_requested", tenantId, principalId, repo });
    return Response.json({ status: "started" }, { status: 202 });
  };
}
