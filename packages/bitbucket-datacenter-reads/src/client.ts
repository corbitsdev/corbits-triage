import { type } from "arktype";

/** Pinned to the instance base URL; the caller's fetch adds the credential. */
export type BitbucketFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const PAGE_LIMIT = 100;

export const Page = type({ values: "unknown[]", isLastPage: "boolean", "nextPageStart?": "number | null" });

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

/** Every page, or the first `maxPages`; with `whole`, more pages than that throws rather than cutting the list short. */
export async function jsonAll(bb: BitbucketFetch, path: string, limit = PAGE_LIMIT, maxPages = Infinity, whole = false): Promise<unknown[]> {
  const separator = path.includes("?") ? "&" : "?";
  const rows: unknown[] = [];
  let start = 0;
  for (let pages = 1; ; pages++) {
    const page = Page.assert(await json(bb, `${path}${separator}limit=${limit}&start=${start}`));
    rows.push(...page.values);
    if (page.isLastPage) return rows;
    if (pages >= maxPages) {
      if (whole) throw new Error(`${path} has more than ${maxPages} pages`);
      return rows;
    }
    if (typeof page.nextPageStart !== "number") throw new Error(`bitbucket returned a page without nextPageStart for ${path}`);
    if (page.nextPageStart <= start) throw new Error(`bitbucket pagination for ${path} did not move past start ${start}`);
    start = page.nextPageStart;
  }
}

export function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
