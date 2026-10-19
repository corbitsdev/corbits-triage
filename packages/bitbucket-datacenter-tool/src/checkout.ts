import { repoPath } from "@corbits/bitbucket-datacenter-reads";
import { checkTarget, unpackArchive } from "@corbits/repo-read-tool";
import type { BitbucketFetch } from "./bitbucket";

/** Unpacks `repo` at `sha` into dir. */
export async function checkout(bb: BitbucketFetch, repo: string, sha: string, dir: string) {
  checkTarget(repo, sha);
  const path = `${repoPath(repo)}/archive?at=${sha}&format=tar.gz`;
  const res = await bb(path);
  if (!res.ok || !res.body) throw new Error(`bitbucket GET ${path} -> ${res.status}`);
  await unpackArchive(res.body, dir, 0);
  return { repo, sha };
}
