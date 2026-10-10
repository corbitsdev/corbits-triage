import type { TriageEvent } from "@corbits/triage-contracts";

export interface MailEvent {
  event?: unknown;
  action?: unknown;
  /** The submitted review, as PrMail carries it. */
  review?: unknown;
  merged?: boolean;
}

const PULL_REQUEST: Record<string, TriageEvent> = {
  opened: "opened",
  reopened: "opened",
  synchronize: "updated",
  edited: "updated",
  ready_for_review: "ready",
  converted_to_draft: "drafted",
};

const REVIEW: Record<string, TriageEvent> = {
  approved: "approved",
  changes_requested: "changes-requested",
};

function reviewState(review: unknown): string {
  return typeof review === "object" && review !== null && "state" in review && typeof review.state === "string" ? review.state.toLowerCase() : "";
}

/** A mail with no event was sent by the reconciler, a backfill or a manual run. Null for webhook actions no pack event names. */
export function triageEventOf({ event, action, review, merged }: MailEvent): TriageEvent | null {
  if (typeof event !== "string") return "catch-up";
  switch (event) {
    case "pull_request":
      if (action === "closed") return merged ? "merged" : "closed";
      return typeof action === "string" ? PULL_REQUEST[action] ?? null : null;
    case "issue_comment":
      return action === "created" ? "commented" : null;
    case "pull_request_review":
      if (action !== "submitted") return null;
      return REVIEW[reviewState(review)] ?? "reviewed";
    case "check_run":
      return "checks";
    default:
      return null;
  }
}
