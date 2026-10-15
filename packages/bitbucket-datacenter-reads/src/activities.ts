import type { PrTimes, TimelineEvent } from "@corbits/github-reads";
import { isoTime, json, jsonAll, Page, PAGE_LIMIT, repoPath, type BitbucketFetch } from "./client.js";
import { Activity, isBot, PullRequest } from "./shapes.js";

/** Activity actions in the GitHub timeline's terms; REVIEWED is a reviewer marking needs work. */
const EVENTS: Record<string, Pick<TimelineEvent, "kind" | "state">> = {
  COMMENTED: { kind: "commented" },
  APPROVED: { kind: "reviewed", state: "APPROVED" },
  REVIEWED: { kind: "reviewed", state: "CHANGES_REQUESTED" },
  MERGED: { kind: "merged" },
  DECLINED: { kind: "closed" },
};

const CLOSED_PAGE = 50;
const CLOSED_PAGES = 8;
const ACTIVITY_PAGES = 5;

function timelineEvent(row: unknown): TimelineEvent[] {
  const activity = Activity.assert(row);
  const event = EVENTS[activity.action];
  return event ? [{ ...event, actor: activity.user.slug, bot: isBot(activity.user), at: isoTime(activity.createdDate) }] : [];
}

/** Oldest first, as on GitHub, from the newest 500 activities. */
export async function listPrTimeline(bb: BitbucketFetch, repo: string, number: number): Promise<TimelineEvent[]> {
  const events = (await jsonAll(bb, `${repoPath(repo)}/pull-requests/${number}/activities`, PAGE_LIMIT, ACTIVITY_PAGES)).flatMap(timelineEvent);
  return events.toSorted((a, b) => a.at.localeCompare(b.at));
}

/** Instances without `closedDate` last updated a closed pull request when it closed. */
function prTimes(pr: PullRequest): PrTimes {
  const closed = pr.state !== "OPEN";
  return {
    number: pr.id,
    author: pr.author.user.slug,
    createdAt: isoTime(pr.createdDate),
    closedAt: closed ? isoTime(pr.closedDate ?? pr.updatedDate) : null,
  };
}

export async function getPrTimes(bb: BitbucketFetch, repo: string, number: number): Promise<PrTimes> {
  return prTimes(PullRequest.assert(await json(bb, `${repoPath(repo)}/pull-requests/${number}`)));
}

/** Newest pull requests closed before `before`: pages back to the first page holding one, reading at most 400. */
export async function listClosedPrsBefore(bb: BitbucketFetch, repo: string, before: Date): Promise<PrTimes[]> {
  const closed: PrTimes[] = [];
  let start = 0;
  for (let i = 0; i < CLOSED_PAGES; i++) {
    const page = Page.assert(await json(bb, `${repoPath(repo)}/pull-requests?state=ALL&order=NEWEST&limit=${CLOSED_PAGE}&start=${start}`));
    for (const row of page.values) {
      const pr = prTimes(PullRequest.assert(row));
      if (pr.closedAt !== null && Date.parse(pr.closedAt) < before.getTime()) closed.push(pr);
    }
    if (page.isLastPage || closed.length > 0) break;
    if (typeof page.nextPageStart !== "number") throw new Error(`bitbucket returned a page without nextPageStart for ${repo} pull requests`);
    start = page.nextPageStart;
  }
  return closed;
}
