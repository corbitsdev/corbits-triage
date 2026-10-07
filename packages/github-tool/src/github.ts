import { setTimeout as sleep } from "node:timers/promises";

/** Authenticated fetch pinned to the GitHub API origin; takes a path. */
export type GithubFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function markerFor(repo: string, number: number, sha: string) {
  return `<!-- corbits-triage:${repo}#${number}@${sha} -->`;
}

const MARKER_PREFIX = "<!-- corbits-triage:";

async function json(gh: GithubFetch, path: string, init?: RequestInit): Promise<any> {
  const res = await gh(path, {
    ...init,
    headers: { accept: "application/vnd.github+json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`github ${init?.method ?? "GET"} ${path} -> ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export type GithubInstallation = {
  id: number;
  account: string;
  htmlUrl: string;
  selection: "all" | "selected";
};

export async function getApp(gh: GithubFetch): Promise<{ slug: string }> {
  const app = await json(gh, "/app") as { slug?: unknown };
  if (typeof app.slug !== "string" || !app.slug) throw new Error("github returned an invalid App slug");
  return { slug: app.slug };
}

export async function listInstallations(gh: GithubFetch): Promise<GithubInstallation[]> {
  const installations: GithubInstallation[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await json(gh, `/app/installations?per_page=100&page=${page}`) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) throw new Error("github returned an invalid installations page");
    for (const row of rows) {
      const account = row.account as Record<string, unknown> | undefined;
      if (!Number.isSafeInteger(row.id) || typeof account?.login !== "string" || typeof row.html_url !== "string" ||
        (row.repository_selection !== "all" && row.repository_selection !== "selected")) {
        throw new Error("github returned an invalid installation");
      }
      installations.push({ id: row.id as number, account: account.login, htmlUrl: row.html_url, selection: row.repository_selection });
    }
    if (rows.length < 100) return installations;
  }
}

export async function listInstallationRepositories(gh: GithubFetch, installationId: number): Promise<string[]> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("installationId must be a positive integer");
  const repositories: string[] = [];
  for (let page = 1; ; page += 1) {
    const result = await json(gh, `/installation/repositories?per_page=100&page=${page}`, {
      headers: { "x-corbits-github-installation-id": String(installationId) },
    }) as { repositories?: Array<{ full_name?: unknown }> };
    if (!Array.isArray(result.repositories)) throw new Error("github returned an invalid installation repositories page");
    for (const repository of result.repositories) {
      if (typeof repository.full_name !== "string" || !repository.full_name) throw new Error("github returned an invalid repository");
      repositories.push(repository.full_name);
    }
    if (result.repositories.length < 100) return repositories;
  }
}

function send(method: string, body: unknown): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
}

export async function listOpenPrs(gh: GithubFetch, repo: string) {
  const prs = await json(gh, `/repos/${repo}/pulls?state=open&per_page=100`);
  return prs.map((p: any) => ({
    number: p.number,
    title: p.title,
    author: p.user?.login,
    draft: p.draft,
    sha: p.head?.sha,
    updatedAt: p.updated_at,
    labels: p.labels?.map((l: any) => l.name) ?? [],
  }));
}

type GithubRepoOwner = { login?: unknown; type?: unknown };

export async function listOrgMembersForRepo(gh: GithubFetch, repo: string): Promise<{ organization: string; members: string[] }> {
  const repository = await json(gh, `/repos/${repo}`) as { owner?: GithubRepoOwner };
  const owner = repository.owner;
  if (owner?.type !== "Organization" || typeof owner.login !== "string" || owner.login.length === 0) {
    throw new Error(`${repo} is not owned by a GitHub organization`);
  }

  const members: string[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await json(gh, `/orgs/${encodeURIComponent(owner.login)}/members?per_page=100&page=${page}`) as Array<{ login?: unknown }>;
    if (!Array.isArray(rows)) throw new Error(`github returned an invalid members page for ${owner.login}`);
    for (const row of rows) {
      if (typeof row.login === "string" && row.login.length > 0) members.push(row.login);
    }
    if (rows.length < 100) break;
  }
  return { organization: owner.login, members: [...new Set(members)].sort((a, b) => a.localeCompare(b)) };
}

const MERGEABLE_RETRIES = 5;
const MERGEABLE_BACKOFF_MS = 1500;

/** GitHub computes mergeability lazily; `mergeable: null` means poll again. */
export async function getPr(gh: GithubFetch, repo: string, number: number) {
  let p = await json(gh, `/repos/${repo}/pulls/${number}`);
  for (let i = 0; i < MERGEABLE_RETRIES && p.mergeable === null && p.state === "open"; i++) {
    await sleep(MERGEABLE_BACKOFF_MS);
    p = await json(gh, `/repos/${repo}/pulls/${number}`);
  }
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    draft: p.draft,
    author: p.user?.login,
    sha: p.head?.sha,
    base: p.base?.ref,
    mergeable: p.mergeable,
    mergeableState: p.mergeable_state,
    requestedReviewers: (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0),
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    labels: p.labels?.map((l: any) => l.name) ?? [],
    updatedAt: p.updated_at,
  };
}

export async function getChecks(gh: GithubFetch, repo: string, sha: string) {
  const r = await json(gh, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
  return r.check_runs.map((c: any) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
  }));
}

export async function getReviews(gh: GithubFetch, repo: string, number: number) {
  const r = await json(gh, `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
  return r.map((v: any) => ({
    reviewer: v.user?.login,
    state: v.state,
    submittedAt: v.submitted_at,
    commitId: v.commit_id,
  }));
}

export type PrCommit = {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
};

export type PrFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type IssueComment = {
  id: number;
  author: string;
  body: string;
  createdAt: string;
};

export async function listPrCommits(gh: GithubFetch, repo: string, number: number): Promise<PrCommit[]> {
  const commits: PrCommit[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await json(gh, `/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`) as Array<Record<string, any>>;
    if (!Array.isArray(rows)) throw new Error("github returned an invalid pull request commits page");
    for (const row of rows) {
      const commit = row.commit ?? {};
      commits.push({
        sha: typeof row.sha === "string" ? row.sha : "",
        message: typeof commit.message === "string" ? commit.message : "",
        author: typeof row.author?.login === "string" ? row.author.login : (typeof commit.author?.name === "string" ? commit.author.name : ""),
        committedAt: typeof commit.committer?.date === "string" ? commit.committer.date : (typeof commit.author?.date === "string" ? commit.author.date : ""),
      });
    }
    if (rows.length < 100) return commits;
  }
}

export async function listPrFiles(gh: GithubFetch, repo: string, number: number): Promise<PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await json(gh, `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`) as Array<Record<string, any>>;
    if (!Array.isArray(rows)) throw new Error("github returned an invalid pull request files page");
    for (const row of rows) {
      const file: PrFile = {
        path: typeof row.filename === "string" ? row.filename : "",
        status: typeof row.status === "string" ? row.status : "",
        additions: typeof row.additions === "number" ? row.additions : 0,
        deletions: typeof row.deletions === "number" ? row.deletions : 0,
      };
      if (typeof row.patch === "string") file.patch = row.patch;
      files.push(file);
    }
    if (rows.length < 100) return files;
  }
}

export async function listIssueComments(gh: GithubFetch, repo: string, number: number): Promise<IssueComment[]> {
  const comments: IssueComment[] = [];
  for (let page = 1; ; page += 1) {
    const rows = await json(gh, `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`) as Array<Record<string, any>>;
    if (!Array.isArray(rows)) throw new Error("github returned an invalid issue comments page");
    for (const row of rows) {
      comments.push({
        id: typeof row.id === "number" ? row.id : 0,
        author: typeof row.user?.login === "string" ? row.user.login : "",
        body: typeof row.body === "string" ? row.body : "",
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
      });
    }
    if (rows.length < 100) return comments;
  }
}

export type LinkedIssue = {
  number: number;
  title: string;
  state: string;
  body: string;
  url: string;
};

const ISSUE_REF = /(?:^|[\s(])#(\d+)\b/g;

/** Same-repo `#n` references in the text that GitHub resolves to issues, not pull requests. */
export async function listReferencedIssues(gh: GithubFetch, repo: string, number: number, text: string): Promise<LinkedIssue[]> {
  const refs = [...new Set([...text.matchAll(ISSUE_REF)].map((m) => Number(m[1])))].filter((n) => n !== number);
  const issues: LinkedIssue[] = [];
  for (const ref of refs) {
    const res = await gh(`/repos/${repo}/issues/${ref}`, { headers: { accept: "application/vnd.github+json" } });
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`github GET /repos/${repo}/issues/${ref} -> ${res.status}`);
    const row = await res.json() as Record<string, any>;
    if (row.pull_request) continue;
    issues.push({
      number: ref,
      title: typeof row.title === "string" ? row.title : "",
      state: typeof row.state === "string" ? row.state : "",
      body: typeof row.body === "string" ? row.body : "",
      url: typeof row.html_url === "string" ? row.html_url : "",
    });
  }
  return issues;
}

export interface MirrorInput {
  repo: string;
  number: number;
  labels: string[];
  comment: string;
  close: boolean;
}

export async function mirror(gh: GithubFetch, i: MirrorInput) {
  const { repo, number } = i;
  const pr = await json(gh, `/repos/${repo}/pulls/${number}`);
  const marker = markerFor(repo, number, pr.head.sha);
  const body = `${marker}\n${i.comment}`;
  const comments = await json(gh, `/repos/${repo}/issues/${number}/comments?per_page=100`);
  const existing = comments.find((c: any) => c.body?.startsWith(marker));
  const prior = comments.find((c: any) => c.body?.startsWith(MARKER_PREFIX));
  const target = existing ?? prior;
  const posted = target
    ? await json(gh, `/repos/${repo}/issues/comments/${target.id}`, send("PATCH", { body }))
    : await json(gh, `/repos/${repo}/issues/${number}/comments`, send("POST", { body }));
  await json(gh, `/repos/${repo}/issues/${number}/labels`, send("PUT", { labels: i.labels }));
  if (i.close) await json(gh, `/repos/${repo}/pulls/${number}`, send("PATCH", { state: "closed" }));
  return { commentId: posted.id, updated: Boolean(target), closed: i.close, sha: pr.head.sha };
}

export const REVIEW_EVENTS = ["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export type CreateReviewInput = {
  repo: string;
  number: number;
  body: string;
  event: ReviewEvent;
};

export async function createReview(gh: GithubFetch, input: CreateReviewInput) {
  if (!REVIEW_EVENTS.includes(input.event)) throw new Error("review event must be COMMENT, APPROVE, or REQUEST_CHANGES");
  const posted = await json(gh, `/repos/${input.repo}/pulls/${input.number}/reviews`, send("POST", {
    body: input.body,
    event: input.event,
  }));
  return { reviewId: posted.id, state: posted.state, event: input.event };
}

export type CreateIssueCommentInput = {
  repo: string;
  number: number;
  body: string;
};

export async function createIssueComment(gh: GithubFetch, input: CreateIssueCommentInput) {
  const posted = await json(gh, `/repos/${input.repo}/issues/${input.number}/comments`, send("POST", { body: input.body }));
  return { commentId: posted.id };
}

export async function addLabels(gh: GithubFetch, input: { repo: string; number: number; labels: string[] }) {
  await json(gh, `/repos/${input.repo}/issues/${input.number}/labels`, send("POST", { labels: input.labels }));
  return { labels: input.labels };
}

export type MergePrInput = {
  repo: string;
  number: number;
};

export async function mergePr(gh: GithubFetch, input: MergePrInput) {
  const pr = await getPr(gh, input.repo, input.number);
  if (pr.mergeable !== true) throw new Error("pull request is not mergeable");
  const merged = await json(gh, `/repos/${input.repo}/pulls/${input.number}/merge`, send("PUT", pr.sha ? { sha: pr.sha } : {}));
  return { merged: merged.merged === true, sha: merged.sha ?? pr.sha };
}
