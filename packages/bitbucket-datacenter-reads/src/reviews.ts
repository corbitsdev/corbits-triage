import type { Review } from "@corbits/github-reads";
import { isoTime, json, jsonAll, repoPath, type BitbucketFetch } from "./client.js";
import { Activity, Participant, PullRequest } from "./shapes.js";

const REVIEW_STATES: Record<string, string> = { APPROVED: "APPROVED", NEEDS_WORK: "CHANGES_REQUESTED" };

const REVIEW_ACTIONS = new Set(["APPROVED", "REVIEWED", "UNAPPROVED"]);

/** When each user last changed their review status; participants carry no time of their own. */
async function reviewedAt(bb: BitbucketFetch, repo: string, number: number): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  for (const row of await jsonAll(bb, `${repoPath(repo)}/pull-requests/${number}/activities`)) {
    const activity = Activity.assert(row);
    const seen = latest.get(activity.user.slug);
    if (REVIEW_ACTIONS.has(activity.action) && (seen === undefined || activity.createdDate > seen)) latest.set(activity.user.slug, activity.createdDate);
  }
  return latest;
}

function review(reviewer: typeof Participant.infer, times: Map<string, number>, triageSlug: string | undefined): Review[] {
  const state = REVIEW_STATES[reviewer.status];
  if (state === undefined) return [];
  const at = times.get(reviewer.user.slug);
  return [{
    reviewer: reviewer.user.slug,
    state,
    ...(at === undefined ? {} : { submittedAt: isoTime(at) }),
    ...(reviewer.lastReviewedCommit === undefined ? {} : { commitId: reviewer.lastReviewedCommit }),
    ...(state === "CHANGES_REQUESTED" && reviewer.user.slug === triageSlug ? { triageRequest: true as const } : {}),
  }];
}

/**
 * Each reviewer's and participant's standing status as a GitHub review; an UNAPPROVED one has none. Data Center keeps
 * the commit a reviewer last reviewed, which is the review's commit, and lists a status set by someone not asked to
 * review, Triage's own included, under participants. `triageSlug` names the user whose NEEDS_WORK is triage's own request.
 */
export async function getReviews(bb: BitbucketFetch, repo: string, number: number, triageSlug?: string): Promise<Review[]> {
  const pr = PullRequest.assert(await json(bb, `${repoPath(repo)}/pull-requests/${number}`));
  const times = await reviewedAt(bb, repo, number);
  return [...pr.reviewers, ...(pr.participants ?? [])].flatMap((reviewer) => review(reviewer, times, triageSlug));
}
