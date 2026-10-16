import { checkTarget, unpackArchive } from "@corbits/repo-read-tool";
import { getFollowingMove, type GithubFetch } from "@corbits/github-reads";

/**
 * Unpacks `repo` at `sha` into dir. The redirect to codeload carries its own short-lived token, so it is fetched
 * without the credential and never returned.
 */
export async function checkout(gh: GithubFetch, repo: string, sha: string, dir: string) {
  checkTarget(repo, sha);
  const res = await getFollowingMove(gh, `/repos/${repo}/tarball/${sha}`);
  const location = res.headers.get("location");
  const archive = res.status === 302 && location ? await fetch(location) : res;
  if (!archive.ok || !archive.body) throw new Error(`github tarball ${repo}@${sha} -> ${archive.status}`);
  await unpackArchive(archive.body, dir, 1);
  return { repo, sha };
}
