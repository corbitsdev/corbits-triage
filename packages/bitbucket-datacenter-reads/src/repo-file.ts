import { type } from "arktype";
import type { RepoFileRead } from "@corbits/github-reads";
import { POLICY_FILE_MAX_BYTES } from "@corbits/triage-contracts";
import { filePath, json, repoPath, request, type BitbucketFetch } from "./client.js";
import { BranchHead } from "./shapes.js";

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

const Branches = type({ values: type({ displayId: "string", latestCommit: "string" }).array() });

/** The head of the named branch, or of the default branch. */
async function branchHead(bb: BitbucketFetch, base: string, branch: string | undefined): Promise<string> {
  if (branch === undefined) return BranchHead.assert(await json(bb, `${base}/branches/default`)).latestCommit;
  const branches = Branches.assert(await json(bb, `${base}/branches?filterText=${encodeURIComponent(branch)}&limit=100`));
  const found = branches.values.find((row) => row.displayId === branch);
  if (!found) throw new Error(`bitbucket has no branch ${branch} in ${base}`);
  return found.latestCommit;
}

/** The text of `path` at commit `sha`, or undefined when nothing is there. */
export async function readFileAt(bb: BitbucketFetch, repo: string, sha: string, path: string): Promise<string | undefined> {
  const url = `${repoPath(repo)}/raw/${filePath(path)}?at=${sha}`;
  const res = await bb(url);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`bitbucket GET ${url} -> ${res.status}`);
  return res.text();
}

/**
 * A file on `branch`, the default branch when absent, or undefined when nothing is there. Every read is pinned to the
 * branch head so the file, its type and its sha agree; the sha is the last commit that changed the file, as Data
 * Center has no blob read.
 */
export async function readRepoFile(bb: BitbucketFetch, repo: string, path: string, branch?: string): Promise<RepoFileRead | undefined> {
  const base = repoPath(repo);
  const file = filePath(path);
  const head = await branchHead(bb, base, branch);
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
