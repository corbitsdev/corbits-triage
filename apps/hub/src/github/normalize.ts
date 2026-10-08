import type { RepoPolicy } from "@corbits/triage-contracts";
import { isTriageComment } from "@corbits/github-tool/github";

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
  policy?: RepoPolicy;
}

type Json = Record<string, any>;

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
  };
}
