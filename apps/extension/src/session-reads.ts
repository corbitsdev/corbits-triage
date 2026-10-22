import { errorText } from "@corbits/common";
import type { GithubFetch } from "@corbits/github-reads";
import type { Reply, TabRequest } from "./messages.ts";
import type { PrRef } from "./pr.ts";
import { parseDiff, type DiffFile } from "./session/diff.ts";

/**
 * How github.com is read as the person signed in: `page` asks a github.com tab's content script for an API path's JSON
 * (null for a path it does not answer); `site` fetches a github.com URL with the person's cookies, for the `.diff`,
 * `.patch` and raw files, which redirect to origins the page may not read.
 */
export type Session = { page(path: string): Promise<string | null>; site(url: string): Promise<Response> };

const FILES = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/files$/;
const COMMITS = /^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\/commits$/;
const CONTENTS = /^\/repos\/([\w.-]+\/[\w.-]+)\/contents\/(.+)$/;
const ROOT = /^\/repos\/([\w.-]+\/[\w.-]+)\/contents$/;
const PATCH_START = /^From ([0-9a-f]{40}) Mon Sep 17 00:00:00 2001$/;
const FILES_PER_PAGE = 100;

type Recorded = { status: number; body: ArrayBuffer };

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** Each commit's whole message by sha, from a pull request's `.patch`, as `git format-patch` writes it. */
export function patchMessages(patch: string): Map<string, string> {
  const messages = new Map<string, string>();
  const lines = patch.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const sha = PATCH_START.exec(lines[at]!)?.[1];
    if (!sha) continue;
    let subject = "";
    for (at++; at < lines.length && lines[at] !== ""; at++) {
      const line = lines[at]!;
      if (line.startsWith("Subject: ")) subject = line.slice("Subject: ".length).replace(/^\[PATCH[^\]]*\] /, "");
      else if (line.startsWith(" ") && subject) subject += line;
    }
    const body: string[] = [];
    for (at++; at < lines.length && lines[at] !== "---" && !PATCH_START.test(lines[at]!); at++) body.push(lines[at]!);
    if (PATCH_START.test(lines[at] ?? "")) at--;
    const text = body.join("\n").trim();
    messages.set(sha, text ? `${subject}\n\n${text}` : subject);
  }
  return messages;
}

/**
 * The REST reads of one run, made through github.com as the person signed in, so a private repository is read with no
 * token. A path the session cannot answer goes to `fallback` (the API with a saved token); with none, the read fails,
 * and the workflow names what it could not read rather than checking without it.
 */
export function sessionGithub(session: Session, fallback: GithubFetch | null): GithubFetch {
  const answers = new Map<string, Promise<Recorded | null>>();
  const diffs = new Map<string, Promise<DiffFile[]>>();

  async function site(url: string): Promise<Response> {
    const res = await session.site(url);
    if (!res.ok) throw new Error(`github.com ${url} -> ${res.status}`);
    return res;
  }

  async function readDiff(repo: string, number: number): Promise<DiffFile[]> {
    return parseDiff(await (await site(`https://github.com/${repo}/pull/${number}.diff`)).text());
  }

  async function filesPage(repo: string, number: number, page: number): Promise<Response> {
    const key = `${repo}#${number}`;
    let diff = diffs.get(key);
    if (!diff) {
      diff = readDiff(repo, number);
      diffs.set(key, diff);
    }
    return Response.json((await diff).slice((page - 1) * FILES_PER_PAGE, page * FILES_PER_PAGE));
  }

  /** The page lists each commit's headline only; its whole message comes from the `.patch`. */
  async function commits(path: string, repo: string, number: number): Promise<Response | null> {
    const listed = await session.page(path);
    if (listed === null) return null;
    const messages = patchMessages(await (await site(`https://github.com/${repo}/pull/${number}.patch`)).text());
    const rows = JSON.parse(listed) as Array<{ sha: string; commit: { message: string } }>;
    return Response.json(rows.map(function withMessage(row) {
      const message = messages.get(row.sha);
      if (message === undefined) throw new Error(`github.com's .patch of ${repo}#${number} has no commit ${row.sha}`);
      return { ...row, commit: { ...row.commit, message } };
    }));
  }

  /** A folder on the default branch, as the page lists it; the API's 404 when nothing is there. */
  async function folder(path: string): Promise<Response | null> {
    const listed = await session.page(path);
    if (listed === null) return null;
    if (listed === "[]") return new Response(null, { status: 404 });
    return new Response(listed, { headers: { "content-type": "application/json" } });
  }

  /** A file at a ref (the default branch when none) in the contents API's shape, else a folder on the default branch. */
  async function contents(path: string, repo: string, file: string, ref: string | null): Promise<Response | null> {
    const at = [...(ref ?? "HEAD").split("/"), ...decodeURIComponent(file).split("/")].map(encodeURIComponent).join("/");
    const res = await session.site(`https://github.com/${repo}/raw/${at}`);
    if (res.status === 404) return ref === null ? folder(path) : new Response(null, { status: 404 });
    if (!res.ok) throw new Error(`github.com ${repo} ${file} -> ${res.status}`);
    const content = base64(new Uint8Array(await res.arrayBuffer()));
    return Response.json({ type: "file", sha: "", encoding: "base64", content, html_url: `https://github.com/${repo}/blob/${at}` });
  }

  async function answer(path: string): Promise<Response | null> {
    const { pathname, searchParams } = new URL(path, "https://api.github.com");
    const files = FILES.exec(pathname);
    if (files) return filesPage(files[1]!, Number(files[2]), Number(searchParams.get("page") ?? 1));
    const listed = COMMITS.exec(pathname);
    if (listed) return commits(path, listed[1]!, Number(listed[2]));
    const file = CONTENTS.exec(pathname);
    if (file) return contents(path, file[1]!, file[2]!, searchParams.get("ref"));
    if (ROOT.test(pathname)) return folder(path);
    const body = await session.page(path);
    return body === null ? null : new Response(body, { headers: { "content-type": "application/json" } });
  }

  async function record(path: string): Promise<Recorded | null> {
    const res = await answer(path);
    return res && { status: res.status, body: await res.arrayBuffer() };
  }

  async function answered(path: string): Promise<Response | null> {
    let pending = answers.get(path);
    if (!pending) {
      pending = record(path);
      answers.set(path, pending);
    }
    try {
      const recorded = await pending;
      if (!recorded) return null;
      const { status, body } = recorded;
      return new Response(status === 404 ? null : body.slice(0), { status, headers: { "content-type": "application/json" } });
    } catch (cause) {
      if (!fallback) throw cause;
      console.warn(`github.com did not answer ${path} for the person signed in: ${errorText(cause)}`);
      return null;
    }
  }

  return async function sessionFirst(path, init) {
    if ((init?.method ?? "GET") !== "GET") throw new Error("The extension only reads from GitHub.");
    const response = await answered(path);
    if (response) return response;
    if (!fallback) throw new Error(`github.com cannot answer ${path} for the person signed in, and no GitHub token is saved to ask its API.`);
    return fallback(path, init);
  };
}

// A tab still loading has no content script to answer yet; it is asked again for about this long.
const TAB_WAIT_MS = 5000;
const TAB_RETRY_MS = 250;

async function askTab(tabId: number, request: TabRequest): Promise<Reply<string | null> | undefined> {
  const end = Date.now() + TAB_WAIT_MS;
  for (;;) {
    try {
      return (await browser.tabs.sendMessage(tabId, request)) as Reply<string | null> | undefined;
    } catch (cause) {
      if (Date.now() > end) throw cause;
      await new Promise((done) => setTimeout(done, TAB_RETRY_MS));
    }
  }
}

/** The person's session in this browser: the pull request's own github.com tab, else any github.com tab, answers page reads. */
export async function browserSession(pr: PrRef, cache: RequestInit["cache"]): Promise<Session> {
  const own = await browser.tabs.query({ url: `https://github.com/${pr.repo}/pull/${pr.number}*` });
  const tabs = own.length ? own : await browser.tabs.query({ url: "https://github.com/*" });
  const tabId = (tabs.find((tab) => tab.status === "complete") ?? tabs[0])?.id;
  const run = crypto.randomUUID();

  async function page(path: string): Promise<string | null> {
    if (tabId === undefined) return null;
    const reply = await askTab(tabId, { type: "session-read", run, path });
    if (!reply) throw new Error("The GitHub tab did not answer.");
    if (!reply.ok) throw new Error(reply.error);
    return reply.value;
  }

  function site(url: string): Promise<Response> {
    return fetch(url, { credentials: "include", cache });
  }

  return { page, site };
}
