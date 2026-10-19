import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
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
    // A form sets its own content type, with the boundary its parts are split on.
    if (init?.body !== undefined && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    return fetchImpl(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  };
}

// The token must not be sent to loopback, private, link-local, unspecified, or cloud-metadata hosts. An operator
// allowlist may name a host whose addresses are only private or loopback; it cannot unlock the rest.
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata"]);

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE.addSubnet("fc00::", 7, "ipv6");

const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet("169.254.0.0", 16, "ipv4");
LINK_LOCAL.addSubnet("fe80::", 10, "ipv6");

// EC2 IPv6 instance metadata. It sits inside fc00::/7, which is otherwise allowlistable.
const METADATA_ADDRESS = new BlockList();
METADATA_ADDRESS.addAddress("fd00:ec2::254", "ipv6");

const UNSPECIFIED = new BlockList();
UNSPECIFIED.addAddress("0.0.0.0", "ipv4");
UNSPECIFIED.addAddress("::", "ipv6");

type AddressKind = "public" | "loopback" | "private" | "link-local" | "unspecified" | "metadata";

/** An IPv6-mapped IPv4 address (`::ffff:169.254.169.254` or `::ffff:a9fe:a9fe`) in dotted form; anything else as given. */
function unmapped(host: string): string {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return host;
  const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function bareHost(hostname: string): string {
  return unmapped(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

function addressKind(address: string): AddressKind | undefined {
  // dns.lookup can return a scoped link-local (`fe80::1%1`). isIP accepts the zone id; BlockList does not.
  const host = bareHost(address).split("%", 1)[0]!;
  const family = isIP(host);
  if (family === 0) return undefined;
  const ipType = family === 4 ? "ipv4" : "ipv6";
  if (UNSPECIFIED.check(host, ipType)) return "unspecified";
  if (LINK_LOCAL.check(host, ipType)) return "link-local";
  if (LOOPBACK.check(host, ipType)) return "loopback";
  if (METADATA_ADDRESS.check(host, ipType)) return "metadata";
  if (PRIVATE.check(host, ipType)) return "private";
  return "public";
}

function isBlockedHost(hostname: string): boolean {
  const host = bareHost(hostname);
  // A trailing dot is the same name (`metadata.google.internal.`).
  if (METADATA_HOSTS.has(host.replace(/\.+$/, ""))) return true;
  const kind = addressKind(host);
  return kind !== undefined && kind !== "public";
}

function allowlisted(hostname: string, allowlist: readonly string[]): boolean {
  const host = bareHost(hostname);
  return allowlist.some((entry) => bareHost(entry) === host);
}

/** A listed literal may be private or loopback. Link-local, unspecified, metadata names, and fd00:ec2::254 stay refused. */
function allowlistedLiteral(hostname: string, allowlist: readonly string[]): boolean {
  if (!allowlisted(hostname, allowlist)) return false;
  const kind = addressKind(bareHost(hostname));
  return kind === "private" || kind === "loopback";
}

/**
 * An http(s) URL without credentials, query or fragment, kept with its context path
 * (an instance can live under one) and without a trailing slash.
 * A literal in a refused range is dropped unless `allowlist` names that literal and it is only private or loopback.
 */
export function instanceBaseUrl(value: string, allowlist: readonly string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return undefined;
  if (isBlockedHost(url.hostname) && !allowlistedLiteral(url.hostname, allowlist)) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export type AddressLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

export function lookupAddresses(hostname: string): Promise<readonly { address: string; family: number }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/**
 * The normalized base URL, or undefined when it is not acceptable or any resolved address is blocked.
 * A listed hostname is still accepted when every blocked address is private or loopback. The result keeps the original host.
 */
export async function resolveInstanceBaseUrl(value: string, lookup: AddressLookup, allowlist: readonly string[] = []): Promise<string | undefined> {
  const accepted = instanceBaseUrl(value, allowlist);
  if (accepted === undefined) return undefined;
  const hostname = new URL(accepted).hostname;
  if (isIP(bareHost(hostname)) !== 0) return accepted;
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await lookup(hostname);
  } catch {
    return undefined;
  }
  if (addresses.length === 0) return undefined;
  const blocked = addresses.map((entry) => addressKind(entry.address)).filter((kind) => kind !== "public");
  if (blocked.length === 0) return accepted;
  if (allowlisted(hostname, allowlist) && blocked.every((kind) => kind === "private" || kind === "loopback")) return accepted;
  return undefined;
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
