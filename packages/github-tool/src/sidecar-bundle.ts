import { defineTool, type BaseEnv } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import type { RuntimeCapabilities } from "@intx/types/runtime-capabilities";

import {
  addAssignees,
  codeownersForPr,
  createIssueComment,
  createReview,
  getChecks,
  getApp,
  getPr,
  getReviews,
  listIssueComments,
  listOrgMembersForRepo,
  listOpenPrs,
  listPrCommits,
  listPrFilesPage,
  listInstallations,
  listInstallationRepositories,
  mergePr,
  mirror,
  requestReviewers,
  type GithubFetch,
} from "./github";

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
    description: "Get reviews for a pull request.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_list_pr_commits",
    description: "List commits on a pull request.",
    inputSchema: obj({ repo, number: { type: "integer" } }),
  },
  {
    name: "github_list_pr_files",
    description: "List one page of files changed on a pull request from offset, with patches when GitHub returns them and they fit. Call again with next until it is absent; patches false leaves patches out.",
    inputSchema: obj({ repo, number: { type: "integer" }, offset: { type: "integer" }, patches: { type: "boolean" } }, ["repo", "number"]),
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
];

const MIRROR_INPUT = obj({
  repo,
  number: { type: "integer" },
  labels: { type: "array", items: str },
  owned: { type: "array", items: str },
  comment: str,
  close: { type: "boolean" },
}, ["repo", "number", "labels", "comment", "close"]);

const WRITE_DEFINITIONS: ToolDefinition[] = [
  {
    name: "github_mirror",
    description:
      "Post (or update) the triage comment on a pull request, add labels and remove any owned label not in labels. Closes it only when close is true. Never merges.",
    inputSchema: MIRROR_INPUT,
  },
  {
    name: "github_mirror_auto",
    description:
      "Post (or update) the triage comment on a pull request without waiting for a human approval, add labels and remove any owned label not in labels. Closes it only when close is true. Never merges.",
    inputSchema: MIRROR_INPUT,
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
}

type ToolCallInput = { id: string; name: string; arguments: Record<string, any> };

async function dispatch(gh: GithubFetch, call: ToolCallInput): Promise<unknown> {
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
    case "github_get_pr":
      return getPr(gh, a.repo, a.number);
    case "github_get_checks":
      return { checks: await getChecks(gh, a.repo, a.sha) };
    case "github_get_reviews":
      return { reviews: await getReviews(gh, a.repo, a.number) };
    case "github_list_pr_commits":
      return { commits: await listPrCommits(gh, a.repo, a.number) };
    case "github_list_pr_files":
      return listPrFilesPage(gh, a.repo, a.number, { offset: a.offset, patches: a.patches !== false });
    case "github_list_issue_comments":
      return { comments: await listIssueComments(gh, a.repo, a.number) };
    case "github_list_org_members":
      return listOrgMembersForRepo(gh, a.repo);
    case "github_codeowners_for_pr":
      return codeownersForPr(gh, a.repo, a.number);
    case "github_mirror":
    case "github_mirror_auto":
      return mirror(gh, {
        repo: a.repo,
        number: a.number,
        labels: a.labels,
        owned: a.owned,
        comment: a.comment,
        close: a.close === true,
      });
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

function createGithubTools(definitions: ToolDefinition[], getFetch: () => Promise<GithubFetch>) {
  async function run(call: ToolCallInput) {
    try {
      const content = await dispatch(await getFetch(), call);
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
    requires: ["capabilities"],
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
      return createGithubTools(definitions, resolveGithubFetch);
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
