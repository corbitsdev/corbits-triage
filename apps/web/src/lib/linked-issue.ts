import type { GithubPullDetail } from "./hub-api.ts";

export type LinearIssue = { key: string; url: string };

type PullText = {
  pr: Pick<GithubPullDetail["pr"], "shownBody">;
  commits: Pick<GithubPullDetail["commits"][number], "message">[];
  comments: Pick<GithubPullDetail["comments"][number], "author" | "body">[];
};

const LINEAR_URL = /https:\/\/linear\.app\/([\w-]+)\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[\w-]*)?/g;
const LINEAR_BOT = "linear[bot]";

/**
 * Linear issues the pull request links to: issue URLs in its shown description and commits, or posted by Linear's bot.
 * Anyone else's comment could point anywhere, and a key linked into two workspaces is ambiguous, so neither is shown.
 * There is no Linear credential, so a bare key with no URL is not resolved.
 */
export function linearIssues(detail: PullText): LinearIssue[] {
  const bot = detail.comments.filter((comment) => comment.author === LINEAR_BOT).map((comment) => comment.body);
  const text = [detail.pr.shownBody, ...detail.commits.map((commit) => commit.message), ...bot].join("\n");
  const byKey = new Map<string, { url: string; workspaces: Set<string> }>();
  for (const [url, workspace, key] of text.matchAll(LINEAR_URL)) {
    const seen = byKey.get(key) ?? { url, workspaces: new Set<string>() };
    seen.workspaces.add(workspace);
    byKey.set(key, seen);
  }
  return [...byKey].filter(([, seen]) => seen.workspaces.size === 1).map(([key, seen]) => ({ key, url: seen.url }));
}
