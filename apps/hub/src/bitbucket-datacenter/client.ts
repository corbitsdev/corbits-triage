import { type } from "arktype";
import { repoPath as repoPathOf, type BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";

export class BitbucketFailed extends Error {
  constructor(readonly status: number, path: string) {
    super(`Bitbucket answered ${status} to ${path}`);
  }
}

export const WEBHOOK_EVENTS = [
  "pr:opened",
  "pr:modified",
  "pr:from_ref_updated",
  "pr:reviewer:approved",
  "pr:reviewer:unapproved",
  "pr:reviewer:needs_work",
  "pr:comment:added",
  "pr:merged",
  "pr:declined",
  "pr:deleted",
  "repo:refs_changed",
] as const;

const Page = type({ values: "unknown[]", isLastPage: "boolean", "nextPageStart?": "number" });
export const InstanceRepo = type({ slug: "string", project: { key: "string" } });
const DefaultBranch = type({ displayId: "string" });
const Webhook = type({ id: "number" });

export function bitbucketFetch(fetchImpl: typeof fetch, baseUrl: string, token: string): BitbucketFetch {
  return function withToken(path, init) {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    if (init?.body !== undefined) headers.set("content-type", "application/json");
    return fetchImpl(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  };
}

// Private-network and localhost hosts are allowed, since Data Center commonly lives on a private network; the hosts a
// cloud runtime answers its own metadata on are not, because the hub's token-check request would reach them.
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "169.254.169.254"]);

/** An IPv6-mapped IPv4 address (`::ffff:169.254.169.254` or `::ffff:a9fe:a9fe`) in dotted form; anything else as given. */
function unmapped(host: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return host;
  const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isMetadataHost(hostname: string): boolean {
  const host = unmapped(hostname.replace(/^\[|\]$/g, "").toLowerCase());
  if (METADATA_HOSTS.has(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // fd00::/8 holds the metadata addresses cloud runtimes publish over IPv6, such as fd00:ec2::254.
  return /^fd[0-9a-f]{2}:/i.test(host);
}

/**
 * An http(s) URL without credentials, query or fragment, kept with its context path
 * (an instance can live under one) and without a trailing slash.
 */
export function instanceBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return undefined;
  if (isMetadataHost(url.hostname)) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export async function pagedValues(bb: BitbucketFetch, path: string): Promise<unknown[]> {
  const values: unknown[] = [];
  let start = 0;
  for (;;) {
    const res = await bb(`${path}?start=${start}&limit=100`);
    if (!res.ok) throw new BitbucketFailed(res.status, path);
    const page = Page.assert(await res.json());
    values.push(...page.values);
    if (page.isLastPage || page.nextPageStart === undefined) return values;
    start = page.nextPageStart;
  }
}

export function repoPath(project: string, slug: string): string {
  return repoPathOf(`${project}/${slug}`);
}

export async function readRepo(bb: BitbucketFetch, project: string, slug: string): Promise<typeof InstanceRepo.infer | undefined> {
  const res = await bb(repoPath(project, slug));
  if (res.status === 404) return undefined;
  if (!res.ok) throw new BitbucketFailed(res.status, repoPath(project, slug));
  return InstanceRepo.assert(await res.json());
}

/** An empty repository has no default branch. */
export async function defaultBranch(bb: BitbucketFetch, project: string, slug: string): Promise<string | undefined> {
  const path = `${repoPath(project, slug)}/default-branch`;
  const res = await bb(path);
  if (res.status === 404 || res.status === 204) return undefined;
  if (!res.ok) throw new BitbucketFailed(res.status, path);
  return DefaultBranch.assert(await res.json()).displayId;
}

export async function webhookExists(bb: BitbucketFetch, project: string, slug: string, id: number): Promise<boolean> {
  const path = `${repoPath(project, slug)}/webhooks/${id}`;
  const res = await bb(path);
  if (res.status === 404) return false;
  if (!res.ok) throw new BitbucketFailed(res.status, path);
  return true;
}

/** The new webhook's id, or undefined when the token may not manage the repository's webhooks. */
export async function createWebhook(bb: BitbucketFetch, project: string, slug: string, url: string, secret: string): Promise<number | undefined> {
  const path = `${repoPath(project, slug)}/webhooks`;
  const body = { name: "Corbits Triage", url, active: true, events: WEBHOOK_EVENTS, configuration: { secret } };
  const res = await bb(path, { method: "POST", body: JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) return undefined;
  if (!res.ok) throw new BitbucketFailed(res.status, path);
  return Webhook.assert(await res.json()).id;
}

export async function deleteWebhook(bb: BitbucketFetch, project: string, slug: string, id: number): Promise<void> {
  const path = `${repoPath(project, slug)}/webhooks/${id}`;
  const res = await bb(path, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new BitbucketFailed(res.status, path);
}
