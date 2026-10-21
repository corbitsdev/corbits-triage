// Every hub request to GitHub passes here: counted per route and installation,
// and held back from an installation GitHub has rate limited until its reset.
import { INSTALLATION_SELECTOR_HEADER, type GithubFetch } from "@corbits/github-reads";

const RESOURCE = /^(app|installations?|repositories|access_tokens|orgs|users?|teams|members|memberships|search|issues|graphql|pulls|comments|labels|commits|check-runs|check-suites|status|statuses|reviews|requested_reviewers|files|merge|git|refs?|trees|blobs|branches|compare|timeline|events|assignees|collaborators|permission|contents)$/;
/** GitHub limited without saying until when, as a secondary limit can. */
const UNTIMED_LIMIT_MS = 60_000;
/** Calls without an installation selector, which the credential adapter resolves per repository. */
const UNSELECTED = "unselected";

export class GithubRateLimited extends Error {
  constructor(readonly installation: string, readonly resetAt: number) {
    super(`GitHub limit reached, back at ${new Date(resetAt).toISOString().slice(11, 16)} UTC`);
    this.name = "GithubRateLimited";
  }
}

/** The path with owners, names, numbers and refs replaced, so counts group by route. */
export function routeOf(path: string): string {
  const segments = new URL(path, "https://api.github.com").pathname.split("/").filter(Boolean);
  const route: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (route.length === 0 && segment === "repos") {
      route.push("repos", ":owner", ":repo");
      i += 2;
    } else if (route.at(-1) === "contents") {
      route.push(":path");
      break;
    } else if (RESOURCE.test(segment)) {
      route.push(segment);
    } else {
      route.push(/^\d+$/.test(segment) ? ":n" : ":id");
    }
  }
  return `/${route.join("/")}`;
}

function limitedUntil(response: Response, now: number): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) return now + Number(retryAfter) * 1000;
  if (response.headers.get("x-ratelimit-remaining") === "0") return Number(response.headers.get("x-ratelimit-reset")) * 1000;
  return response.status === 429 ? now + UNTIMED_LIMIT_MS : undefined;
}

type RateLimit = { remaining: number; resetAt: string };

export function createGithubUsage(now: () => number = Date.now) {
  const blockedUntil = new Map<string, number>();
  let routes = new Map<string, number>();
  let installations = new Map<string, number>();
  let blocked = new Map<string, number>();
  const rateLimits = new Map<string, RateLimit>();

  function bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  function observe(installation: string, response: Response): void {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    if (remaining !== null && reset !== null) {
      rateLimits.set(installation, { remaining: Number(remaining), resetAt: new Date(Number(reset) * 1000).toISOString() });
    }
    const until = limitedUntil(response, now());
    if (until !== undefined && until > now()) {
      blockedUntil.set(installation, until);
      throw new GithubRateLimited(installation, until);
    }
  }

  return {
    gate(gh: GithubFetch): GithubFetch {
      return async function gatedFetch(path, init) {
        const installation = new Headers(init?.headers).get(INSTALLATION_SELECTOR_HEADER) ?? UNSELECTED;
        const until = blockedUntil.get(installation);
        if (until !== undefined && until > now()) {
          bump(blocked, installation);
          throw new GithubRateLimited(installation, until);
        }
        blockedUntil.delete(installation);
        bump(routes, `${init?.method ?? "GET"} ${routeOf(path)}`);
        bump(installations, installation);
        const response = await gh(path, init);
        observe(installation, response);
        return response;
      };
    },
    /** The `github_calls` line for the calls since the last one, or undefined when there were none. */
    flush(): Record<string, unknown> | undefined {
      if (installations.size === 0 && blocked.size === 0) return undefined;
      const line = {
        level: "info",
        msg: "github_calls",
        routes: Object.fromEntries(routes),
        installations: Object.fromEntries(installations),
        blocked: Object.fromEntries(blocked),
        rateLimits: Object.fromEntries(rateLimits),
      };
      routes = new Map();
      installations = new Map();
      blocked = new Map();
      return line;
    },
  };
}

export const githubUsage = createGithubUsage();
