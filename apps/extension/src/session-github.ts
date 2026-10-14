import { readPr, readRepoDocs, type GithubFetch } from "@corbits/github-reads";
import type { RepoDocs } from "@corbits/triage-workflows/logic/facts";
import type { PublicGithub } from "./github-public.ts";
import type { Reply, TabRequest } from "./messages.ts";
import { parseDiff, type DiffFile } from "./session/diff.ts";
import type { SessionAnswer } from "./session/page-reads.ts";
import type { ReadCounts } from "./view.ts";

/**
 * `head` reads only the pull request's head commit, for a revisit deciding whether to score again; `docs` the
 * repository's docs and contribution rules on its default branch, as `readRepoDocs` gives them.
 */
export type GithubReads = { gh: GithubFetch; rate: PublicGithub["rate"]; counts(): ReadCounts; head(): Promise<string>; docs(repo: string): Promise<RepoDocs> };

const FILES = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/files$/;
const CONTENTS = /^\/repos\/([\w.-]+\/[\w.-]+)\/contents\/(.+)$/;
const FILES_PER_PAGE = 100;

export type ReadTarget = { repo: string; number?: number };

async function readerTab(target: ReadTarget): Promise<number | undefined> {
  const own = target.number === undefined ? [] : await browser.tabs.query({ url: `https://github.com/${target.repo}/pull/${target.number}*` });
  const any = own.length ? own : await browser.tabs.query({ url: "https://github.com/*" });
  return any.find((tab) => tab.id !== undefined && tab.status === "complete")?.id ?? any[0]?.id;
}

// A tab still loading has no content script to answer yet; it is asked again for about this long.
const TAB_WAIT_MS = 5000;
const TAB_RETRY_MS = 250;

async function askTab(tabId: number, request: TabRequest): Promise<Reply<SessionAnswer | null> | undefined> {
  const end = Date.now() + TAB_WAIT_MS;
  for (;;) {
    try {
      return (await browser.tabs.sendMessage(tabId, request)) as Reply<SessionAnswer | null> | undefined;
    } catch (cause) {
      if (Date.now() > end) throw cause;
      await new Promise((done) => setTimeout(done, TAB_RETRY_MS));
    }
  }
}

/**
 * GitHub reads for one run through the session of the person signed in to github.com, falling back path by path to
 * GitHub's REST API with the person's token; without one (`api` null) a read the session cannot make fails, so the
 * shared limit for requests without a token is never spent. Page reads run in a github.com tab's content script,
 * same-origin; the `.diff` and raw files are read here, since they redirect to origins the page may not read.
 */
export async function sessionGithub(pr: ReadTarget, api: PublicGithub | null): Promise<GithubReads> {
  const run = crypto.randomUUID();
  const tabId = await readerTab(pr);
  const answers = new Map<string, Promise<Response | null>>();
  let diff: Promise<DiffFile[]> | undefined;
  let pageRequests = 0;
  let ownRequests = 0;
  const fellBack = new Set<string>();

  async function readDiff(repo: string, number: number): Promise<DiffFile[]> {
    ownRequests++;
    const res = await fetch(`https://github.com/${repo}/pull/${number}.diff`, { credentials: "include", cache: "no-store" });
    if (!res.ok) throw new Error(`github.com ${repo}#${number}.diff -> ${res.status}`);
    return parseDiff(await res.text());
  }

  async function filesPage(repo: string, number: number, page: number): Promise<Response> {
    diff ??= readDiff(repo, number);
    const files = await diff;
    return Response.json(files.slice((page - 1) * FILES_PER_PAGE, page * FILES_PER_PAGE));
  }

  async function raw(repo: string, ref: string, file: string): Promise<Response> {
    ownRequests++;
    const path = [...ref.split("/"), ...file.split("/")].map(encodeURIComponent).join("/");
    return fetch(`https://github.com/${repo}/raw/${path}`, { credentials: "include", cache: "no-store" });
  }

  async function contents(repo: string, file: string, ref: string): Promise<Response> {
    const res = await raw(repo, ref, decodeURIComponent(file));
    if (res.status === 404) return new Response(null, { status: 404 });
    if (!res.ok) throw new Error(`github.com ${repo} ${file} -> ${res.status}`);
    return new Response(await res.arrayBuffer());
  }

  // A tab whose content script never answered (gone after an update, say) is not waited on again this run.
  let tabGone = tabId === undefined;

  async function fromPage(path: string): Promise<Response | null> {
    if (tabGone || tabId === undefined) return null;
    let reply: Reply<SessionAnswer | null> | undefined;
    try {
      reply = await askTab(tabId, { type: "session-read", run, path });
    } catch (cause) {
      tabGone = true;
      throw cause;
    }
    if (!reply?.ok) throw new Error(reply ? reply.error : "The GitHub tab did not answer.");
    if (!reply.value) return null;
    pageRequests = Math.max(pageRequests, reply.value.requests);
    return new Response(reply.value.body, { headers: { "content-type": "application/json" } });
  }

  async function answer(path: string): Promise<Response | null> {
    const { pathname, searchParams } = new URL(path, "https://api.github.com");
    const files = FILES.exec(pathname);
    const file = CONTENTS.exec(pathname);
    const ref = searchParams.get("ref");
    try {
      if (files) return await filesPage(files[1]!, Number(files[2]), Number(searchParams.get("page") ?? 1));
      if (file && ref) return await contents(file[1]!, file[2]!, ref);
      return await fromPage(path);
    } catch (cause) {
      console.warn(`Could not read ${path} as the person signed in: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }

  const gh: GithubFetch = async function sessionFirst(path, init) {
    let answered = answers.get(path);
    if (!answered) {
      answered = answer(path);
      answers.set(path, answered);
    }
    const response = await answered;
    if (response) return response.clone();
    if (!api) throw new Error(`GitHub did not answer ${path} for the person signed in, and no GitHub token is saved to ask its API.`);
    fellBack.add(path);
    return api.gh(path, init);
  };

  async function head(): Promise<string> {
    if (pr.number === undefined) throw new Error(`No pull request of ${pr.repo} to read the head of.`);
    const answered = await answer(`/repos/${pr.repo}/pulls/${pr.number}/head`);
    if (answered) return ((await answered.json()) as { sha: string }).sha;
    return (await readPr(gh, pr.repo, pr.number)).sha;
  }

  const docsRead = new Map<string, Promise<RepoDocs>>();

  async function readDocs(repo: string): Promise<RepoDocs> {
    const listed = await fromPage(`/repos/${repo}/doc-paths`);
    if (!listed) throw new Error("No github.com tab lists the repository's files.");
    const { ref, paths } = (await listed.json()) as { ref: string; paths: string[] };
    return readRepoDocs(paths, async function bytes(file) {
      const res = await raw(repo, ref, file);
      if (!res.ok) throw new Error(`github.com ${repo} ${file} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  // Kept like the other answers, so a rescore replays them; a failed read is tried again.
  async function docs(repo: string): Promise<RepoDocs> {
    let read = docsRead.get(repo);
    if (!read) {
      read = readDocs(repo);
      docsRead.set(repo, read);
    }
    try {
      return await read;
    } catch (cause) {
      docsRead.delete(repo);
      throw cause;
    }
  }

  return { gh, head, docs, rate: () => api?.rate(), counts: () => ({ session: pageRequests + ownRequests, api: fellBack.size }) };
}
