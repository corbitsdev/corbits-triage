import { type } from "arktype";
import type { RepoFileRead } from "@corbits/github-reads";
import { POLICY_FILE_MAX_BYTES } from "@corbits/triage-contracts";
import { filePath, json, repoPath, request, type BitbucketFetch } from "./client.js";

const DefaultBranch = type({ latestCommit: "string" });
const Browse = type({ type: "string" });
const Commits = type({ values: type({ id: "string" }).array() });
const Repository = type({ links: { self: type({ href: "string" }).array().atLeastLength(1) } });

const utf8 = new TextDecoder();

/** Null past the policy file cap, the largest file a caller reads this way; decoded with web APIs so the extension can reuse it. */
async function cappedText(res: Response): Promise<string | null> {
  if (Number(res.headers.get("content-length")) > POLICY_FILE_MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length > POLICY_FILE_MAX_BYTES ? null : utf8.decode(bytes);
}

/**
 * A file on the default branch, or undefined when nothing is there. Every read is pinned to the branch head so the
 * file, its type and its sha agree; the sha is the last commit that changed the file, as Data Center has no blob read.
 */
export async function readRepoFile(bb: BitbucketFetch, repo: string, path: string): Promise<RepoFileRead | undefined> {
  const base = repoPath(repo);
  const file = filePath(path);
  const head = DefaultBranch.assert(await json(bb, `${base}/branches/default`)).latestCommit;
  const at = `at=${encodeURIComponent(head)}`;
  const browse = await bb(`${base}/browse/${file}?type=true&${at}`, { headers: { accept: "application/json" } });
  if (browse.status === 404) return undefined;
  if (!browse.ok) throw new Error(`bitbucket GET ${base}/browse/${file} -> ${browse.status}`);
  if (Browse.assert(await browse.json()).type !== "FILE") return { kind: "not-a-file" };
  const text = await cappedText(await request(bb, `${base}/raw/${file}?${at}`));
  const [last] = Commits.assert(await json(bb, `${base}/commits?path=${encodeURIComponent(path)}&until=${encodeURIComponent(head)}&limit=1`)).values;
  if (last === undefined) throw new Error(`bitbucket has no commit for ${path} in ${repo}`);
  const browseUrl = Repository.assert(await json(bb, base)).links.self[0]!.href;
  return { kind: "file", sha: last.id, text, url: `${browseUrl}/${file}` };
}
