import type { GithubFetch } from "@corbits/github-reads";
import { clock } from "./clock.ts";

export const GITHUB_API = "https://api.github.com";

export type RateLimit = { limit: number; remaining: number; resetAt: string };

export class GithubRateLimitError extends Error {
  constructor(public readonly resetAt: string, withToken: boolean) {
    const which = withToken ? "Your GitHub token's hourly limit" : "GitHub's hourly limit for requests without a token";
    super(`${which} is used up. It resets at ${clock(resetAt)}.`);
    this.name = "GithubRateLimitError";
  }
}

type Recorded = { status: number; headers: Headers; body: ArrayBuffer };

export type PublicGithub = {
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
 * GitHub's REST API for one run, without a token or with the person's own. The files and docs pagers read the same GitHub page once per
 * slice, and 304s still count against the unauthenticated limit, so each GET is sent once and replayed. GitHub lets
 * the browser cache its answers for a minute; `no-cache` revalidates them when a person asks for a fresh read.
 */
export function publicGithub(cache: RequestCache, token: string | null): PublicGithub {
  const sent = new Map<string, Promise<Recorded>>();
  let latest: RateLimit | undefined;

  async function send(path: string, init?: RequestInit): Promise<Recorded> {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers, cache });
    const rate = rateOf(res.headers);
    if (rate) latest = rate;
    if ((res.status === 403 || res.status === 429) && rate?.remaining === 0) throw new GithubRateLimitError(rate.resetAt, token !== null);
    return { status: res.status, headers: res.headers, body: await res.arrayBuffer() };
  }

  async function gh(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    if (method !== "GET") throw new Error("Local mode only reads from GitHub.");
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const key = `${accept} ${path}`;
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
    const { status, headers, body } = response;
    return new Response(status === 204 ? null : body.slice(0), { status, headers });
  }

  return { gh, rate: () => latest };
}
