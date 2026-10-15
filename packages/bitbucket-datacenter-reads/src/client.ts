import { type } from "arktype";

/** Pinned to the instance base URL; the caller's fetch adds the credential. */
export type BitbucketFetch = (path: string, init?: RequestInit) => Promise<Response>;

const PAGE_LIMIT = 100;

const Page = type({ values: "unknown[]", isLastPage: "boolean", "nextPageStart?": "number | null" });

/** A repository is named `PROJECTKEY/slug`. */
export function repoParts(repo: string): { project: string; slug: string } {
  const [project, slug, extra] = repo.split("/");
  if (!project || !slug || extra !== undefined) throw new Error(`bitbucket repository must be PROJECT/slug, got ${repo}`);
  return { project: encodeURIComponent(project), slug: encodeURIComponent(slug) };
}

export function repoPath(repo: string): string {
  const { project, slug } = repoParts(repo);
  return `/rest/api/1.0/projects/${project}/repos/${slug}`;
}

export function filePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export async function request(bb: BitbucketFetch, path: string): Promise<Response> {
  const res = await bb(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`bitbucket GET ${path} -> ${res.status}`);
  return res;
}

export async function json(bb: BitbucketFetch, path: string): Promise<unknown> {
  return (await request(bb, path)).json();
}

export async function jsonAll(bb: BitbucketFetch, path: string, limit = PAGE_LIMIT): Promise<unknown[]> {
  const separator = path.includes("?") ? "&" : "?";
  const rows: unknown[] = [];
  let start = 0;
  for (;;) {
    const page = Page.assert(await json(bb, `${path}${separator}limit=${limit}&start=${start}`));
    rows.push(...page.values);
    if (page.isLastPage) return rows;
    if (typeof page.nextPageStart !== "number") throw new Error(`bitbucket returned a page without nextPageStart for ${path}`);
    start = page.nextPageStart;
  }
}

export function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
