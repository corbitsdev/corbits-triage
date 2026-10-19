import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";

import {
  appLogin,
  authorTeams,
  codeownersForPr,
  getChecks,
  getApp,
  getPr,
  getReviews,
  listIssueComments,
  listOrgMembersForRepo,
  listClosedPrsPage,
  listOpenPrs,
  listPrCommits,
  listPrFilesPage,
  listInstallations,
  listInstallationRepositories,
  readFileAt,
  readRepoDocsPage,
  type AppLogin,
  type GithubFetch,
} from "@corbits/github-reads";
import {
  addAssignees,
  createIssueComment,
  createReview,
  dismissDoApprovals,
  dismissDoChangeRequests,
  mergePr,
  mirror,
  requestReviewers,
} from "./github";
import { DoNotRunnableError, executeDo, parseDoInput } from "./do";
import { cachedLoads, checkTarget, linesOf, MAX_LINES } from "@corbits/repo-read-tool";
import { checkout } from "./checkout";

export const CREDENTIAL_HANDLE = "github";

const str = { type: "string" };
const repo = { type: "string", description: "owner/name" };
function obj(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return {
    type: "object",
    properties,
    required,
  };
}

const READ_DEFINITIONS: ToolDefinition[] = [
  { name: "github_get_app", description: "Get the authenticated GitHub App.", inputSchema: obj({}) },
  { name: "github_list_installations", description: "List every installation of the authenticated GitHub App.", inputSchema: obj({}) },
  { name: "github_list_installation_repositories", description: "List every selected repository for one App installation.", inputSchema: obj({ installationId: { type: "integer" } }) },
  {
    name: "github_list_open_prs",
    description: "List open pull requests for a repository.",
    inputSchema: obj({ repo }),
  },
  {
    name: "github_list_closed_prs",
    description: "List one page of closed pull requests for a repository, most recently updated first, with whether each was merged. Call again with next until next is absent.",
    inputSchema: obj({ repo, page: { type: "integer" } }),
  },
  {
    name: "github_get_pr",
    description: "Get one pull request.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_get_checks",
    description: "Get check runs for a commit sha.",
    inputSchema: obj({ repo, sha: str }),
  },
  {
    name: "github_get_reviews",
    description: "Get reviews for a pull request, marking this App's own request-changes Do reviews as triageRequest.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_list_pr_commits",
    description: "List commits on a pull request.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_list_pr_files",
    description: "List one page of files changed on a pull request from offset, with patches when GitHub returns them. Call again with next, and patchNext as patchOffset when present, until next is absent; a patch continued on the next page is the rest of the previous page's last patch. patches false leaves patches out.",
    inputSchema: obj({ repo, number: { type: "integer" }, offset: { type: "integer" }, patchOffset: { type: "integer" }, patches: { type: "boolean" } }, ["repo", "number"]),
  },
  {
    name: "github_read_repo_docs",
    description: "Read one page of a repository's docs (its own markdown, README first) and its contribution rules from offset, on ref or the default branch. Call again with next and the returned ref until next is absent.",
    inputSchema: obj({ repo, ref: str, offset: { type: "integer" } }, ["repo"]),
  },
  {
    name: "github_list_issue_comments",
    description: "List issue comments on a pull request conversation.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_list_org_members",
    description: "List every member of the organization that owns a repository.",
    inputSchema: obj({ repo }),
  },
  {
    name: "github_codeowners_for_pr",
    description: "List the code owners (users and team slugs) of a pull request's changed files from the base branch's CODEOWNERS, without the author.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_author_teams",
    description: "Say which of the given teams (@org/slug or slug) the author is an active member of. Teams past the first 20, outside the repository owner's organization, or not confirmable either way are unknown.",
    inputSchema: obj({ repo, author: str, teams: { type: "array", items: str } }),
  },
  {
    name: "github_read_file",
    description: `Read lines start to end (1-based, inclusive) of a file at a commit sha, at most ${MAX_LINES} lines, each prefixed with its line number.`,
    inputSchema: obj({ repo, sha: str, path: str, start: { type: "integer" }, end: { type: "integer" } }, ["repo", "sha", "path"]),
  },
  {
    name: "github_checkout",
    description: "Download a repository's files at a commit sha into the step's working tree, replacing what is there.",
    inputSchema: obj({ repo, sha: str }),
  },
];

const ARTIFACT_REF = obj({ id: str, version: { type: "number" } });

const MIRROR_INPUT = obj({
  repo,
  number: { type: "integer" },
  labels: { type: "array", items: str },
  owned: { type: "array", items: str },
  keep: { type: "array", items: str, description: "While the pull request carries any of these labels, its labels are left as they are" },
  comment: str,
  header: {
    ...obj({
      head: str,
      policy: { type: ["object", "null"], properties: { repo: ARTIFACT_REF, shared: ARTIFACT_REF }, required: ["repo"] },
      verdict: str,
    }),
    description: "What the comment is written for; an unchanged one is not written again",
  },
  notReadyHead: str,
  fixedHead: str,
  onHead: { ...str, description: "Write nothing once the pull request has moved past this head" },
}, ["repo", "number", "labels"]);

const WRITE_DEFINITIONS: ToolDefinition[] = [
  {
    name: "github_mirror",
    description:
      "Post (or update) the triage comment on a pull request when comment is given, add labels and remove any owned label not in labels, unless it carries a keep label. While notReadyHead is the head, which may not be approved, dismisses the approve Do's standing approvals; while fixedHead is the head, which leaves the author nothing to fix, dismisses the request-changes Do's standing requests. Writes nothing to a closed pull request. Never merges.",
    inputSchema: MIRROR_INPUT,
  },
  {
    name: "github_mirror_auto",
    description:
      "Post (or update) the triage comment on a pull request when comment is given, without waiting for a human approval, add labels and remove any owned label not in labels, unless it carries a keep label. While notReadyHead is the head, which may not be approved, dismisses the approve Do's standing approvals; while fixedHead is the head, which leaves the author nothing to fix, dismisses the request-changes Do's standing requests. Writes nothing to a closed pull request. Never merges.",
    inputSchema: MIRROR_INPUT,
  },
  {
    name: "github_execute_do_auto",
    description:
      "Run one resolved triage Do on a pull request without waiting for a human approval, unless GitHub already shows it: add labels (removing the ones it names in unlabel) or assignees, request reviews, post a comment, approve, request changes, close, or merge. A close also upserts the triage comment, adds the request's labels and removes owned labels not in them, as github_mirror does. A close, merge, comment or review is refused once the pull request has moved past headSha; a review is pinned to headSha and satisfied when this App already made it there, and a merge merges headSha only. Returns { status } as done, satisfied (already on GitHub) or skipped with a reason. Merges only for a merge Do.",
    inputSchema: obj({ request: MIRROR_INPUT, step: obj({ effectId: str, headSha: str, kind: str, target: { type: "object" } }) }),
  },
  {
    name: "github_create_review",
    description: "Create a pull request review with event COMMENT, APPROVE, or REQUEST_CHANGES. Never merges.",
    inputSchema: obj({
      repo,
      number: { type: "integer" },
      body: str,
      event: { type: "string", description: "COMMENT | APPROVE | REQUEST_CHANGES" },
    }),
  },
  {
    name: "github_create_issue_comment",
    description: "Post a conversation comment on a pull request. Never merges.",
    inputSchema: obj({ repo, number: { type: "integer" }, body: str }),
  },
  {
    name: "github_add_assignees",
    description: "Add assignees to a pull request. Never merges.",
    inputSchema: obj({ repo, number: { type: "integer" }, assignees: { type: "array", items: str } }),
  },
  {
    name: "github_request_reviewers",
    description: "Request reviews on a pull request from users and teams (team slugs). Never merges.",
    inputSchema: obj(
      { repo, number: { type: "integer" }, reviewers: { type: "array", items: str }, teamReviewers: { type: "array", items: str } },
      ["repo", "number"],
    ),
  },
  {
    name: "github_merge_pr",
    description: "Merge a pull request only when GitHub reports mergeable is true. Refuses otherwise. Never called from github_mirror.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
];

interface Env extends BaseEnv {
  capabilities: RuntimeCapabilities;
  toolCwd: string;
}

type ToolCallInput = { id: string; name: string; arguments: Record<string, any> };

/** A Do that cannot run is reported, not failed, so the run goes on. */
async function runDo(gh: GithubFetch, args: unknown, login: AppLogin) {
  try {
    const { status } = await executeDo(gh, parseDoInput(args), login);
    return { status };
  } catch (err) {
    if (err instanceof DoNotRunnableError) return { status: "skipped", reason: err.message };
    throw err;
  }
}

/** A file at a commit, fetched once per tool instance however many windows of it are read. */
type FileAt = (repo: string, sha: string, path: string) => Promise<string | undefined>;

async function readWindow(fileAt: FileAt, a: Record<string, any>) {
  checkTarget(a.repo, a.sha, a.path);
  const text = await fileAt(a.repo, a.sha, a.path);
  if (text === undefined) throw new Error(`${a.path} is not in ${a.repo} at ${a.sha}`);
  return linesOf(a.path, text, a.start, a.end);
}

async function dispatch(gh: GithubFetch, call: ToolCallInput, login: AppLogin, toolCwd: string, fileAt: FileAt): Promise<unknown> {
  const a = call.arguments;
  switch (call.name) {
    case "github_get_app":
      return getApp(gh);
    case "github_list_installations":
      return { installations: await listInstallations(gh) };
    case "github_list_installation_repositories":
      return { repositories: await listInstallationRepositories(gh, a.installationId) };
    case "github_list_open_prs":
      return { prs: await listOpenPrs(gh, a.repo) };
    case "github_list_closed_prs":
      return listClosedPrsPage(gh, a.repo, a.page);
    case "github_get_pr":
      return getPr(gh, a.repo, a.number);
    case "github_get_checks":
      return { checks: await getChecks(gh, a.repo, a.sha) };
    case "github_get_reviews":
      return { reviews: await getReviews(gh, a.repo, a.number, login) };
    case "github_list_pr_commits":
      return { commits: await listPrCommits(gh, a.repo, a.number) };
    case "github_list_pr_files":
      return listPrFilesPage(gh, a.repo, a.number, { offset: a.offset, patchOffset: a.patchOffset, patches: a.patches !== false });
    case "github_read_repo_docs":
      return readRepoDocsPage(gh, a.repo, { ref: a.ref, offset: a.offset });
    case "github_list_issue_comments":
      return { comments: await listIssueComments(gh, a.repo, a.number) };
    case "github_list_org_members":
      return listOrgMembersForRepo(gh, a.repo);
    case "github_codeowners_for_pr":
      return codeownersForPr(gh, a.repo, a.number);
    case "github_author_teams":
      return authorTeams(gh, { repo: a.repo, author: a.author, teams: a.teams });
    case "github_read_file":
      return readWindow(fileAt, a);
    case "github_checkout":
      return checkout(gh, a.repo, a.sha, toolCwd);
    case "github_mirror":
    case "github_mirror_auto": {
      const mirrored = await mirror(gh, {
        repo: a.repo,
        number: a.number,
        labels: a.labels,
        owned: a.owned,
        keep: a.keep,
        comment: a.comment,
        header: a.header,
        onHead: a.onHead,
        close: false,
      }, login);
      if ("skipped" in mirrored) return mirrored;
      if (a.notReadyHead !== mirrored.sha && a.fixedHead !== mirrored.sha) return mirrored;
      const target = { repo: a.repo, number: a.number, login: await login() };
      const dismissed = a.notReadyHead === mirrored.sha ? await dismissDoApprovals(gh, target) : [];
      if (a.fixedHead !== mirrored.sha) return { ...mirrored, dismissed };
      // A repository may restrict who dismisses reviews; the comment and labels still stand, and the reason is kept.
      try {
        return { ...mirrored, dismissed: [...dismissed, ...await dismissDoChangeRequests(gh, target)] };
      } catch (err) {
        return { ...mirrored, dismissed, changeRequestsKept: err instanceof Error ? err.message : String(err) };
      }
    }
    case "github_execute_do_auto":
      return runDo(gh, a, login);
    case "github_create_review":
      return createReview(gh, { repo: a.repo, number: a.number, body: a.body ?? "", event: a.event });
    case "github_create_issue_comment":
      return createIssueComment(gh, { repo: a.repo, number: a.number, body: a.body });
    case "github_add_assignees":
      return addAssignees(gh, { repo: a.repo, number: a.number, assignees: a.assignees });
    case "github_request_reviewers":
      return requestReviewers(gh, { repo: a.repo, number: a.number, reviewers: a.reviewers, teamReviewers: a.teamReviewers });
    case "github_merge_pr":
      return mergePr(gh, { repo: a.repo, number: a.number });
    default:
      throw new Error(`unknown tool ${call.name}`);
  }
}

/** The App's login and each file read are asked of GitHub once per tool instance, so once per step of a run. */
function createGithubTools(definitions: ToolDefinition[], getFetch: () => Promise<GithubFetch>, toolCwd: string) {
  let known: string | undefined;
  const files = cachedLoads<string | undefined>();
  async function run(call: ToolCallInput) {
    try {
      const gh = await getFetch();
      async function login() {
        known ??= await appLogin(gh);
        return known;
      }
      function fileAt(repo: string, sha: string, path: string) {
        return files(`${repo}@${sha}:${path}`, () => readFileAt(gh, repo, sha, path));
      }
      const content = await dispatch(gh, call, login, toolCwd, fileAt);
      return { callId: call.id, content: content as Record<string, unknown> };
    } catch (err) {
      return {
        callId: call.id,
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }
  return { definitions, run };
}

function defineGithubTool(id: string, definitions: ToolDefinition[], ask: readonly string[]) {
  return defineTool<Env>({
    id,
    requires: ["capabilities", "toolCwd"],
    definitions: definitions.map((d) => ({
      name: d.name,
      ...(ask.includes(d.name) ? { approval: "ask" as const } : {}),
    })),
    factory: function githubToolFactory(env) {
      async function resolveGithubFetch(): Promise<GithubFetch> {
        const mediated = await env.capabilities
          .resolve("credentials")
          .resolve(CREDENTIAL_HANDLE);
        if (mediated.kind !== "http") {
          throw new Error(`github credential must be http, got ${mediated.kind}`);
        }
        return function githubFetch(path, init) {
          return mediated.fetch(path, init);
        };
      }
      return createGithubTools(definitions, resolveGithubFetch, env.toolCwd);
    },
  });
}

export const githubRead = defineGithubTool("@corbits/github-tool/sidecar-bundle", READ_DEFINITIONS, []);
export const githubWrite = defineGithubTool("@corbits/github-write-tool/sidecar-bundle", WRITE_DEFINITIONS, [
  "github_mirror",
  "github_create_review",
  "github_create_issue_comment",
  "github_add_assignees",
  "github_request_reviewers",
  "github_merge_pr",
]);
