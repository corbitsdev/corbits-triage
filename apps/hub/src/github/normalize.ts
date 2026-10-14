import type { RepoPolicy } from "@corbits/triage-contracts";
import { isTriageComment } from "@corbits/github-reads";

const EVENTS = ["pull_request", "pull_request_review", "issue_comment", "check_run"] as const;

export interface PrMail {
  kind: "pr";
  repo: string;
  prNumber: number | null;
  deliveryId: string;
  event: string;
  action: string | null;
  headSha: string | null;
  author: string | null;
  title: string | null;
  body: string | null;
  /** Null when the payload does not say, as on check_run. */
  draft: boolean | null;
  review: { state: string } | null;
  policy?: RepoPolicy;
}

type Json = Record<string, any>;

export type BaseMove = { repo: string; merged: number };

export function baseMoveOf(event: string, p: Json): BaseMove | null {
  const pr = p?.pull_request;
  const repo = p?.repository?.full_name;
  if (event !== "pull_request" || p.action !== "closed" || pr?.merged !== true || typeof repo !== "string" || typeof pr.number !== "number") return null;
  return pr.base?.ref === p.repository.default_branch ? { repo, merged: pr.number } : null;
}

/** `removed` when the last commit that touched the file removed it. */
export type PolicyPush = { repo: string; removed: boolean };

function lists(paths: unknown, path: string): boolean {
  return Array.isArray(paths) && paths.includes(path);
}

/**
 * A push to the default branch that may have changed `path`; null for anything else. A forced push's commits need not
 * list what it replaced, so it always counts.
 */
export function policyPushOf(event: string, p: Json, path: string): PolicyPush | null {
  const repo = p?.repository?.full_name;
  if (event !== "push" || typeof repo !== "string" || p.ref !== `refs/heads/${p.repository.default_branch}`) return null;
  const commits: Json[] = Array.isArray(p.commits) ? p.commits : [];
  const last = commits.findLast((commit) => [commit?.added, commit?.modified, commit?.removed].some((paths) => lists(paths, path)));
  if (!last && p.forced !== true) return null;
  return { repo, removed: last !== undefined && lists(last.removed, path) };
}

export function normalize(event: string, deliveryId: string, p: Json): PrMail | null {
  if (!(EVENTS as readonly string[]).includes(event)) return null;
  const repo = p.repository?.full_name;
  if (!repo) return null;
  let pr: Json | undefined = p.pull_request;
  if (event === "issue_comment") {
    if (!p.issue?.pull_request) return null;
    if (isTriageComment(String(p.comment?.body ?? ""))) return null;
    pr = p.issue;
  } else if (event === "check_run") {
    pr = p.check_run?.pull_requests?.[0];
  }
  if (pr?.state === "closed") return null;
  return {
    kind: "pr",
    repo,
    prNumber: pr?.number ?? null,
    deliveryId,
    event,
    action: p.action ?? null,
    headSha: pr?.head?.sha ?? p.check_run?.head_sha ?? p.after ?? null,
    author: pr?.user?.login ?? null,
    title: pr?.title ?? null,
    body: pr?.body ?? null,
    draft: typeof pr?.draft === "boolean" ? pr.draft : null,
    review: typeof p.review?.state === "string" ? { state: p.review.state } : null,
  };
}
