import { teamsOfAuthor, type AuthorTeams, type Codeowners, type Membership } from "@corbits/github-reads";
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

/** The filter matches any part of a name or email, so a group can take many pages. A failed page or a malformed row is unknown. */
async function membership(bb: BitbucketFetch, group: string, author: string): Promise<Membership> {
  try {
    const members = await jsonAll(bb, `/rest/api/1.0/admin/groups/more-members?context=${encodeURIComponent(group)}&filter=${encodeURIComponent(author)}`, 1000);
    return members.map((user) => User.assert(user).slug).includes(author) ? "member" : "not";
  } catch {
    return "unknown";
  }
}

/** Data Center groups are global, so `@PROJECT/group` and `group` both name the group. Listing members needs admin permission; without it a group is unknown. */
export async function authorTeams(bb: BitbucketFetch, input: { repo: string; author: string; teams: string[] }): Promise<AuthorTeams> {
  return teamsOfAuthor(input, (group) => membership(bb, group, input.author));
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
