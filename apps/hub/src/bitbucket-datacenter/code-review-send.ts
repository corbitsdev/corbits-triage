// A person's send of a code review to a Bitbucket Data Center pull request. Their click is the approval, so it runs in
// the hub with the workspace's Bitbucket token, under the same comment grant as GitHub's send.
import { type } from "arktype";
import { errorText } from "@corbits/common";
import { sendCodeReview, tokenUser } from "@corbits/bitbucket-datacenter-tool/bitbucket";
import type { CodeReviewRuns } from "../code-review-runs.js";
import { tenantConfigOf } from "../github/bridge.js";
import { doRefused, failure, sourceCredentialGrant, type PortalCredentialDeps } from "../github/portal-credential.js";
import { sendReview } from "../github/pr-actions.js";
import type { RepoReads } from "../github/repo-reads.js";
import { repoRecords, sourceOf, triageNs } from "../github/tenant-config.js";
import type { Member } from "../integrations/app.js";
import type { TenantBitbucket } from "./tenant-bitbucket.js";

export const CodeReviewSendBody = type({ repo: /^[^/]+\/[^/]+$/, number: "number.integer > 0", headSha: "string > 0" });

export function createBitbucketCodeReviewSend(deps: PortalCredentialDeps & {
  tenantBitbucket: TenantBitbucket;
  codeReviews: Pick<CodeReviewRuns, "latest">;
  changed: RepoReads["changed"];
  log: (entry: Record<string, unknown>) => void;
}) {
  return async function send(body: typeof CodeReviewSendBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    const { repo, number, headSha } = body;
    const refused = (await sourceCredentialGrant(deps, principalId, tenantId, { source: "bitbucket-datacenter" }, "use")) ?? (await doRefused(deps, principalId, tenantId, "bitbucket-datacenter", repo, "comment"));
    if (refused) return refused;
    const connected = repoRecords(triageNs(await tenantConfigOf(deps, tenantId))).some((row) => row.name === repo && sourceOf(row) === "bitbucket-datacenter");
    if (!connected) return failure(409, "repo_not_connected", "This Bitbucket repository is not connected.");
    const bb = await deps.tenantBitbucket(tenantId);
    if (!bb) return failure(409, "bitbucket_datacenter_not_connected", "Connect Bitbucket Data Center first.");
    try {
      const { completed, carriedTo } = await deps.codeReviews.latest(tenantId, { repo, source: "bitbucket-datacenter", number, head: headSha });
      const result = await sendReview(function sendToBitbucket(input) {
        return sendCodeReview(bb, input, function user() {
          return tokenUser(bb);
        });
      }, body, completed, carriedTo);
      if (result instanceof Response) return result;
      deps.changed(tenantId, repo);
      deps.log({ level: "info", msg: "bitbucket_code_review_sent", tenantId, principalId, repo, number });
      return Response.json(result);
    } catch (err) {
      deps.log({ level: "warn", msg: "bitbucket_code_review_send_failed", tenantId, repo, number, error: errorText(err) });
      return failure(502, "bitbucket_datacenter_failed", `Sending the code review to ${repo}#${number} failed: ${errorText(err)}`);
    }
  };
}
