import { type } from "arktype";
import { MAX_AUTHOR_TEAMS, type AuthorTeams, type Codeowners } from "@corbits/github-reads";
import { teamSlug } from "@corbits/triage-contracts/team";
import { json, jsonAll, repoParts, repoPath, type BitbucketFetch } from "./client.js";
import { PullRequest, User } from "./shapes.js";

export type Association = "OWNER" | "MEMBER" | "COLLABORATOR" | "NONE";

// Effective permissions, so grants through groups and global permissions count, and no admin permission is needed to ask.
const ASSOCIATIONS: Array<{ association: Association; permission: string; scope: "project" | "repo" }> = [
  { association: "OWNER", permission: "PROJECT_ADMIN", scope: "project" },
  { association: "MEMBER", permission: "PROJECT_READ", scope: "project" },
  { association: "COLLABORATOR", permission: "REPO_READ", scope: "repo" },
];

async function holds(bb: BitbucketFetch, repo: string, author: string, permission: string, scope: "project" | "repo"): Promise<boolean> {
  const { project, slug } = repoParts(repo);
  const target = scope === "project" ? `permission.projectKey=${project}` : `permission.projectKey=${project}&permission.repositorySlug=${slug}`;
  const users = await jsonAll(bb, `/rest/api/1.0/users?filter=${encodeURIComponent(author)}&permission=${permission}&${target}`);
  return users.some((user) => User.assert(user).slug === author);
}

/** The author's standing in the repository, in GitHub's author association terms, which decide the trust tier. */
export async function authorAssociation(bb: BitbucketFetch, repo: string, author: string): Promise<Association> {
  for (const { association, permission, scope } of ASSOCIATIONS) {
    if (await holds(bb, repo, author, permission, scope)) return association;
  }
  return "NONE";
}

const GroupMembers = type({ values: User.array() });

type Membership = "member" | "not" | "unknown";

async function membership(bb: BitbucketFetch, group: string, author: string): Promise<Membership> {
  const res = await bb(`/rest/api/1.0/admin/groups/more-members?context=${encodeURIComponent(group)}&filter=${encodeURIComponent(author)}&limit=1000`, { headers: { accept: "application/json" } });
  if (!res.ok) return "unknown";
  return GroupMembers.assert(await res.json()).values.some((user) => user.slug === author) ? "member" : "not";
}

/** Data Center groups are global, so `@PROJECT/group` and `group` both name the group. Listing members needs admin permission; without it a group is unknown. */
export async function authorTeams(bb: BitbucketFetch, input: { repo: string; author: string; teams: string[] }): Promise<AuthorTeams> {
  const result: AuthorTeams = { teams: [], unknown: input.teams.slice(MAX_AUTHOR_TEAMS) };
  for (const team of input.teams.slice(0, MAX_AUTHOR_TEAMS)) {
    const group = teamSlug(team, input.repo);
    const answer = group === null ? "unknown" : await membership(bb, group, input.author);
    if (answer === "member") result.teams.push(team);
    else if (answer === "unknown") result.unknown.push(team);
  }
  return result;
}

/** The default reviewers Data Center's conditions name for this pull request, less its author; Data Center has no team reviewers. */
export async function defaultReviewers(bb: BitbucketFetch, repo: string, number: number): Promise<Codeowners> {
  const pr = PullRequest.assert(await json(bb, `${repoPath(repo)}/pull-requests/${number}`));
  const { project, slug } = repoParts(repo);
  const query = new URLSearchParams({
    sourceRepoId: String(pr.fromRef.repository.id),
    targetRepoId: String(pr.toRef.repository.id),
    sourceRefId: pr.fromRef.id,
    targetRefId: pr.toRef.id,
  });
  const users = User.array().assert(await json(bb, `/rest/default-reviewers/1.0/projects/${project}/repos/${slug}/reviewers?${query}`));
  return { users: users.flatMap((user) => (user.slug === pr.author.user.slug ? [] : [user.slug])), teams: [] };
}
