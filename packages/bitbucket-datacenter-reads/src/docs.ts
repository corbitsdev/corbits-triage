import { fitsDocsPage, readRepoDocs, type RepoDocsPage, type RuleSpan } from "@corbits/github-reads";
import { type } from "arktype";
import { filePath, json, jsonAll, repoPath, request, type BitbucketFetch } from "./client.js";
import { BranchHead } from "./shapes.js";

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

type Docs = { texts: Array<[string, string]>; rules: RuleSpan[] };

/** A tree is listed at most this many paths per page. */
const FILES_PAGE = 1000;

/** The repository's docs at the head, as `repoDocs` would assemble them from the pages below: each path once, read as far as its docs or rules budget reaches. */
async function docsAt(bb: BitbucketFetch, repo: string, head: string): Promise<Docs> {
  const base = repoPath(repo);
  const at = `at=${encodeURIComponent(head)}`;
  const paths = (await jsonAll(bb, `${base}/files?${at}`, FILES_PAGE)).map((row) => type("string").assert(row));
  async function read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await request(bb, `${base}/raw/${filePath(path)}?${at}`)).arrayBuffer());
  }
  const { docs, rules } = await readRepoDocs(paths, read);
  const texts = new Map<string, string>(Object.entries(docs));
  for (const [path, text] of Object.entries(rules)) if (text.length > (texts.get(path)?.length ?? 0)) texts.set(path, text);
  const spans = Object.keys(rules).map((path) => ({ path, docsBytes: byteLength(docs[path] ?? ""), rulesBytes: byteLength(rules[path]!) }));
  return { texts: [...texts], rules: spans };
}

/** The docs of each head read once per reader; the pages of one read all come from the same listing. */
export function createDocsReader(bb: BitbucketFetch) {
  const read = new Map<string, Promise<Docs>>();
  return async function docsOf(repo: string, head: string): Promise<Docs> {
    const key = `${repo}@${head}`;
    const pending = read.get(key) ?? docsAt(bb, repo, head);
    read.set(key, pending);
    try {
      return await pending;
    } catch (err) {
      read.delete(key);
      throw err;
    }
  };
}

/** The longest prefix of `bytes` from `from` that fits the page, never splitting a character. */
function fittingEnd(page: RepoDocsPage, path: string, bytes: Uint8Array, from: number): number {
  let low = from;
  let high = bytes.length;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    while (middle < bytes.length && (bytes[middle]! & 0xc0) === 0x80) middle++;
    if (middle <= low) break;
    if (fitsDocsPage(page, { path, text: decoder.decode(bytes.subarray(from, middle)) })) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * One page of the repository's docs at `ref`, in the shape GitHub's reader answers. Data Center lists a tree without
 * sizes, so every doc within budget is read on each page; `offset` counts bytes across the docs in order.
 */
export async function readRepoDocsPage(bb: BitbucketFetch, repo: string, { ref, offset = 0, docs = docsAt.bind(null, bb) }: { ref?: string; offset?: number; docs?: ReturnType<typeof createDocsReader> } = {}): Promise<RepoDocsPage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid docs offset ${offset}`);
  const head = ref ?? BranchHead.assert(await json(bb, `${repoPath(repo)}/branches/default`)).latestCommit;
  const { texts, rules } = await docs(repo, head);
  const page: RepoDocsPage = { docs: [], rules, ref: head };
  let start = 0;
  for (const [path, text] of texts) {
    const bytes = utf8.encode(text);
    if (offset < start + bytes.length) {
      const from = Math.max(offset - start, 0);
      const end = fittingEnd(page, path, bytes, from);
      if (end > from) page.docs.push({ path, text: decoder.decode(bytes.subarray(from, end)) });
      if (end < bytes.length) {
        page.next = start + end;
        return page;
      }
    }
    start += bytes.length;
  }
  return page;
}
