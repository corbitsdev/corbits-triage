// The pull request that writes a repository's saved rules to its policy file, on one branch so it is opened once:
// asking again updates the open one, and with none open the branch starts over from the default branch.
import { json, readRepoFileResponse, type GithubFetch } from "@corbits/github-reads";

export const POLICY_BRANCH = "corbits-triage/policy";

export type PolicyChange = { path: string; text: string; title: string; body: string };
export type PolicyPull = { url: string; number: number };

type Pull = { number: number; html_url: string };

function pullOf(pull: Pull): PolicyPull {
  return { url: pull.html_url, number: pull.number };
}

async function openPull(gh: GithubFetch, repo: string, base: string): Promise<Pull | undefined> {
  const owner = repo.split("/", 1)[0];
  const pulls: Pull[] = await json(gh, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${POLICY_BRANCH}`)}&base=${encodeURIComponent(base)}`);
  return pulls[0];
}

export async function openPolicyPull(gh: GithubFetch, repo: string): Promise<PolicyPull | undefined> {
  const { default_branch: base } = await json(gh, `/repos/${repo}`);
  const pull = await openPull(gh, repo, base);
  return pull && pullOf(pull);
}

/** The branch at the default branch's head, made or moved there; a branch left from an earlier pull request is moved. */
async function branchFromBase(gh: GithubFetch, repo: string, base: string): Promise<void> {
  // Unverified against GitHub for a default branch whose name holds a slash.
  const head = await json(gh, `/repos/${repo}/git/ref/heads/${encodeURIComponent(base)}`);
  const res = await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${POLICY_BRANCH}`, sha: head.object.sha }) });
  if (res.ok) return;
  if (res.status !== 422 || !(await res.text()).includes("Reference already exists")) throw new Error(`github POST /repos/${repo}/git/refs -> ${res.status}`);
  await json(gh, `/repos/${repo}/git/refs/heads/${POLICY_BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: head.object.sha, force: true }) });
}

async function commitFile(gh: GithubFetch, repo: string, { path, text, title }: PolicyChange): Promise<void> {
  const url = `/repos/${repo}/contents/${path}`;
  const current = await readRepoFileResponse(await gh(`${url}?ref=${encodeURIComponent(POLICY_BRANCH)}`, { headers: { accept: "application/vnd.github+json" } }), url);
  if (current?.kind === "file" && current.text === text) return;
  const sha = current?.kind === "file" ? { sha: current.sha } : {};
  await json(gh, url, { method: "PUT", body: JSON.stringify({ message: title, content: Buffer.from(text, "utf8").toString("base64"), branch: POLICY_BRANCH, ...sha }) });
}

/** Opens the pull request, or brings the open one up to `change`. */
export async function proposePolicy(gh: GithubFetch, repo: string, change: PolicyChange): Promise<PolicyPull> {
  const { default_branch: base } = await json(gh, `/repos/${repo}`);
  const open = await openPull(gh, repo, base);
  if (!open) await branchFromBase(gh, repo, base);
  await commitFile(gh, repo, change);
  if (open) {
    await json(gh, `/repos/${repo}/pulls/${open.number}`, { method: "PATCH", body: JSON.stringify({ title: change.title, body: change.body }) });
    return pullOf(open);
  }
  return createPull(gh, repo, base, change);
}

/** A pull request opened by a concurrent call in between is answered instead of refused. */
async function createPull(gh: GithubFetch, repo: string, base: string, { title, body }: PolicyChange): Promise<PolicyPull> {
  const path = `/repos/${repo}/pulls`;
  const res = await gh(path, { method: "POST", headers: { accept: "application/vnd.github+json" }, body: JSON.stringify({ title, head: POLICY_BRANCH, base, body }) });
  if (res.ok) return pullOf(await res.json() as Pull);
  const raced = res.status === 422 ? await openPull(gh, repo, base) : undefined;
  if (raced) return pullOf(raced);
  throw new Error(`github POST ${path} -> ${res.status}`);
}
