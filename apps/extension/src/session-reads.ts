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
const PULL = /^\/repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+$/;
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

const ENCODED_WORD = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
// After the message, `git format-patch` writes `---` and the diffstat: one line a file, then the summary.
const DIFFSTAT = /^ (?:.+ \| |\d+ files? changed)/;

function wordBytes(encoding: string, text: string): Uint8Array {
  if (encoding.toLowerCase() === "b") return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  const bytes: number[] = [];
  const spaced = text.replaceAll("_", " ");
  for (let at = 0; at < spaced.length; at++) {
    const hex = /^=([0-9a-f]{2})/i.exec(spaced.slice(at));
    if (hex) {
      bytes.push(parseInt(hex[1]!, 16));
      at += 2;
    } else bytes.push(spaced.charCodeAt(at));
  }
  return Uint8Array.from(bytes);
}

/** A header with its RFC 2047 encoded words decoded; the space between two of them is folding, not text. */
function decodedHeader(text: string): string {
  return text.replace(/\?=\s+=\?/g, "?==?").replace(ENCODED_WORD, function decode(_word, charset: string, encoding: string, data: string) {
    return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(wordBytes(encoding, data));
  });
}

/** git's `-- ` line and version that close each patch, which an empty commit, with no `---`, runs into. */
function isSignature(lines: string[], at: number): boolean {
  return lines[at] === "-- " && /^\d+\.\d+/.test(lines[at + 1] ?? "");
}

/**
 * Each commit's whole message by sha, from a pull request's `.patch`, as `git format-patch` writes it. A `---` line in a
 * message cannot be told from the one that ends it unless the diffstat follows, so a message that seems cut short throws.
 */
function patchMessages(patch: string): Map<string, string> {
  const messages = new Map<string, string>();
  const lines = patch.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const sha = PATCH_START.exec(lines[at]!)?.[1];
    if (!sha) continue;
    let subject = "";
    for (at++; at < lines.length && lines[at] !== ""; at++) {
      const line = lines[at]!;
      if (line.startsWith("Subject: ")) subject = line.slice("Subject: ".length);
      else if (line.startsWith(" ") && subject) subject += line;
    }
    subject = decodedHeader(subject).replace(/^\[PATCH[^\]]*\] /, "");
    const body: string[] = [];
    for (at++; at < lines.length && lines[at] !== "---" && !PATCH_START.test(lines[at]!) && !isSignature(lines, at); at++) body.push(lines[at]!);
    if (lines[at] === "---" && !DIFFSTAT.test(lines[at + 1] ?? "")) throw new Error(`the .patch message of ${sha} may be cut short at a --- line`);
    if (PATCH_START.test(lines[at] ?? "")) at--;
    const text = body.join("\n").trim();
    messages.set(sha, text ? `${subject}\n\n${text}` : subject);
  }
  return messages;
}

const TOKEN_HINT = "Save a GitHub token in the side panel to read it through GitHub's API.";

/** `missed` says why reads the session could not make failed, with no token saved to make them instead; the known causes first. */
export type SessionReads = { gh: GithubFetch; missed(): string[] };

/**
 * The REST reads of one run, made through github.com as the person signed in, so a private repository is read with no
 * token. A path the session cannot answer goes to `fallback` (the API with a saved token); with none, the read fails,
 * and the workflow names what it could not read rather than checking without it.
 */
export function sessionGithub(session: Session, fallback: GithubFetch | null): SessionReads {
  const failed: string[] = [];
  const unanswered: string[] = [];
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
      if (message === undefined) throw new Error(`A commit of ${repo}#${number} (such as a merge commit) is not in github.com's .patch, so it can't be read without a GitHub token.`);
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
    if (body === null) return null;
    // The page gives the description as written, not GitHub's rendering of it, which hidden-content reads.
    if (PULL.test(pathname) && typeof JSON.parse(body).body_html !== "string") throw new Error("github.com did not give the pull request's rendered description, which can't be read without a GitHub token.");
    return new Response(body, { headers: { "content-type": "application/json" } });
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
      if (!fallback) {
        failed.push(`${errorText(cause)} ${TOKEN_HINT}`);
        throw cause;
      }
      console.warn(`github.com did not answer ${path} for the person signed in: ${errorText(cause)}`);
      return null;
    }
  }

  const gh: GithubFetch = async function sessionFirst(path, init) {
    if ((init?.method ?? "GET") !== "GET") throw new Error("The extension only reads from GitHub.");
    const response = await answered(path);
    if (response) return response;
    if (!fallback) {
      unanswered.push(`github.com does not show ${path} to the extension. ${TOKEN_HINT}`);
      throw new Error(`github.com cannot answer ${path} for the person signed in, and no GitHub token is saved to ask its API.`);
    }
    return fallback(path, init);
  };

  return { gh, missed: () => [...new Set([...failed, ...unanswered])] };
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
