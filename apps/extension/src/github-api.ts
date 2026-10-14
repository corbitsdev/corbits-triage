import type { GithubFetch } from "@corbits/github-reads";
import { clock } from "./clock.ts";

export const GITHUB_API = "https://api.github.com";

export type RateLimit = { limit: number; remaining: number; resetAt: string };

export class GithubRateLimitError extends Error {
  constructor(public readonly resetAt: string) {
    super(`Your GitHub token's hourly limit is used up. It resets at ${clock(resetAt)}.`);
    this.name = "GithubRateLimitError";
  }
}

type Recorded = { status: number; headers: Headers; body: ArrayBuffer };

export type GithubApi = {
  gh: GithubFetch;
  rate(): RateLimit | undefined;
};

function rateOf(headers: Headers): RateLimit | undefined {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return undefined;
  return { limit: Number(limit), remaining: Number(remaining), resetAt: new Date(Number(reset) * 1000).toISOString() };
}

/**
 * GitHub's REST API for one run, read-only, with the person's token. The files and docs pagers read the same page once
 * per slice, so each GET is sent once and replayed. The browser's cache revalidates GitHub's answers by ETag; `no-cache`
 * revalidates even those under a minute old, when a person asks for a fresh read.
 */
export function githubApi(token: string, cache: RequestCache): GithubApi {
  const sent = new Map<string, Promise<Recorded>>();
  let latest: RateLimit | undefined;

  async function send(path: string, init?: RequestInit): Promise<Recorded> {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers, cache: init?.cache ?? cache });
    const rate = rateOf(res.headers);
    if (rate) latest = rate;
    if ((res.status === 403 || res.status === 429) && rate?.remaining === 0) throw new GithubRateLimitError(rate.resetAt);
    return { status: res.status, headers: res.headers, body: await res.arrayBuffer() };
  }

  async function gh(path: string, init?: RequestInit): Promise<Response> {
    if ((init?.method ?? "GET") !== "GET") throw new Error("The extension only reads from GitHub.");
    const headers = new Headers(init?.headers);
    const key = `${headers.get("accept") ?? ""} ${headers.get("if-none-match") ?? ""} ${path}`;
    let recorded = sent.get(key);
    if (!recorded) {
      recorded = send(path, init);
      sent.set(key, recorded);
    }
    let response: Recorded;
    try {
      response = await recorded;
    } catch (cause) {
      // A failed read is tried again by the next run rather than replayed.
      sent.delete(key);
      throw cause;
    }
    const { status, headers: answered, body } = response;
    return new Response(status === 204 || status === 304 ? null : body.slice(0), { status, headers: answered });
  }

  return { gh, rate: () => latest };
}
