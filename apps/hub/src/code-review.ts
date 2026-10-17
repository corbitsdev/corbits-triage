import { type } from "arktype";
import type { DB } from "@intx/db";
import { REPO_SOURCES } from "@corbits/triage-contracts";
import { activeCredential, failure } from "./github/portal-credential.js";
import { ANTHROPIC_CREDENTIAL, connectedSources } from "./github/source-workflow.js";
import { tenantConfigOf } from "./github/bridge.js";
import { patchCorbitsTriage, repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import type { Member } from "./integrations/app.js";

export const CODE_REVIEW_PATH = "/api/integrations/code-review";

const Source = type.enumerated(...REPO_SOURCES);

export const CodeReviewBody = type({ repo: "string > 0", "source?": Source, enabled: "boolean" });
export const CodeReviewSet = type({ repo: "string", source: Source, codeReview: "boolean" });

type CodeReviewDeps = {
  db: DB["db"];
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  /** After a change: a host's code review deployment is released once none of its repositories has it on. */
  onChanged: (tenantId: string) => Promise<void>;
};

const HOST_NAMES = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" } as const;

/** Turns code review on or off for one repository; on needs its host connected and the workspace's Anthropic key. */
export function createCodeReviewSwitch(deps: CodeReviewDeps) {
  return async function setCodeReview(body: typeof CodeReviewBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    if (!(await deps.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage"))) {
      return failure(403, "forbidden", "You do not have permission to manage this workspace.");
    }
    const source = body.source ?? "github";
    if (body.enabled && !(await connectedSources(deps.db, tenantId)).includes(source)) {
      return failure(409, "source_not_connected", `Connect ${HOST_NAMES[source]} before turning on code review.`);
    }
    if (body.enabled && !(await activeCredential(deps.db, tenantId, ANTHROPIC_CREDENTIAL))) {
      return failure(409, "anthropic_key_missing", "Save an Anthropic key in Settings before turning on code review.");
    }
    function isRepo(record: RepoRecord): boolean {
      return record.name === body.repo && sourceOf(record) === source;
    }
    function setRepo(record: RepoRecord): RepoRecord {
      return isRepo(record) ? { ...record, codeReview: body.enabled } : record;
    }
    const stored = repoRecords(triageNs(await tenantConfigOf(deps, tenantId))).find(isRepo);
    if (!stored) return failure(404, "repo_not_found", "The workspace has no such repository.");
    if (body.enabled && !stored.connected) return failure(409, "repo_not_connected", `${body.repo} is no longer connected to ${HOST_NAMES[source]}.`);
    const written = await patchCorbitsTriage(deps.db, tenantId, function setRepoCodeReview(ns) {
      const repos = repoRecords(ns);
      return repos.some(isRepo) ? { ...ns, repos: repos.map(setRepo) } : undefined;
    });
    if (!written || !repoRecords(written).some(isRepo)) return failure(404, "repo_not_found", "The workspace has no such repository.");
    await deps.onChanged(tenantId);
    return Response.json({ repo: body.repo, source, codeReview: body.enabled });
  };
}
