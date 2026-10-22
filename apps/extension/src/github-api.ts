import type { GithubFetch } from "@corbits/github-reads";
import { clock } from "./clock.ts";

export const GITHUB_API = "https://api.github.com";

class GithubRateLimitError extends Error {
  constructor(resetAt: string) {
    super(`GitHub's hourly limit for its API is used up. It resets at ${clock(resetAt)}.`);
    this.name = "GithubRateLimitError";
  }
}

type Recorded = { status: number; headers: Headers; body: ArrayBuffer };

export type GithubApi = { gh: GithubFetch };

/** When the token's hourly limit resets, once it is used up. */
function exhaustedUntil(headers: Headers): string | undefined {
  const reset = headers.get("x-ratelimit-reset");
  if (headers.get("x-ratelimit-remaining") !== "0" || reset === null) return undefined;
  return new Date(Number(reset) * 1000).toISOString();
}

/**
 * GitHub's REST API for one run, read-only, with the person's token, else without one, within GitHub's shared limit for public reads. The files and docs pagers read the same page once
 * per slice, so each GET is sent once and replayed. The browser's cache revalidates GitHub's answers by ETag; `no-cache`
 * revalidates even those under a minute old, when a person asks for a fresh read.
 */
export function githubApi(token: string | null, cache: RequestInit["cache"]): GithubApi {
  const sent = new Map<string, Promise<Recorded>>();

  async function send(path: string, init?: RequestInit): Promise<Recorded> {
    const headers = new Headers(init?.headers);
    // The run's credential stands in its own placeholder; only the person's token, if any, goes to GitHub.
    headers.delete("authorization");
    if (token) headers.set("authorization", `Bearer ${token}`);
    const res = await fetch(`${GITHUB_API}${path}`, { ...init, headers, cache: init?.cache ?? cache });
    const resetAt = exhaustedUntil(res.headers);
    if ((res.status === 403 || res.status === 429) && resetAt) throw new GithubRateLimitError(resetAt);
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

  return { gh };
}
