// The hub's side of a pull request's manager. A pull request mail is recorded as an event, then sent to the workspace's
// listener, which deploys the manager itself and mails it.
import { randomUUID } from "node:crypto";
import type { DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { repoSourceOf, type RepoSource } from "@corbits/triage-contracts";
import { reviewRequestOf, type PullRequestToReview } from "./code-review-feed.js";
import type { TriageJob } from "./github/coordinator.js";
import type { RepoRecord } from "./github/tenant-config.js";
import { recordEvent } from "./manager-state.js";

export type ManagerIntakeDeps = {
  db: DB["db"];
  /** The address of the workspace's live listener for the host, if it has one. */
  listener: (tenantId: string, source: RepoSource) => Promise<string | undefined>;
  /** The pull request as its host shows it now, with its diff. */
  readPull: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestToReview>;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
};

export function createManagerIntake(deps: ManagerIntakeDeps) {
  /** The review request for the mail's head when its policy turns code review on, so the manager can hand it on. */
  async function reviewRequest(job: TriageJob, request: Record<string, unknown>): Promise<object | undefined> {
    if (asRecord(request["codeReview"])?.["on"] !== true || !job.record) return undefined;
    const pull = await deps.readPull(job.tenantId, job.record, job.number);
    return pull.headSha === job.headSha ? reviewRequestOf(job.record, job.number, pull) : undefined;
  }

  /** Records a pull request mail and sends it to the host's listener; false, with nothing recorded, when the workspace has none. */
  return async function toListener(job: TriageJob): Promise<boolean> {
    const request = asRecord(job.payload);
    if (request?.["kind"] !== "pr") return false;
    const source = repoSourceOf(request["repoSource"]);
    const address = await deps.listener(job.tenantId, source);
    if (!address) return false;
    const codeReviewRequest = request["codeReviewRequest"] ?? (await reviewRequest(job, request));
    await recordEvent(deps.db, job.tenantId, { source, repo: job.repo, number: job.number }, randomUUID(), { type: "webhook", head: job.headSha, payload: {} });
    await deps.deliver(job.tenantId, address, { ...request, tenantId: job.tenantId, ...(codeReviewRequest !== undefined && { codeReviewRequest }) });
    return true;
  };
}
