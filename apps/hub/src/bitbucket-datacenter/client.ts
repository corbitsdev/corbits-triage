import { lookup as dnsLookup } from "node:dns/promises";
import { type } from "arktype";
import ipaddr from "ipaddr.js";
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
  "pr:comment:edited",
  "pr:merged",
  "pr:declined",
  "pr:deleted",
  "repo:refs_changed",
] as const;

const Page = type({ values: "unknown[]", isLastPage: "boolean", "nextPageStart?": "number" });
export const InstanceRepo = type({ slug: "string", project: { key: "string" } });
const DefaultBranch = type({ displayId: "string" });
const Webhook = type({ id: "number" });

/** Every request connects to the checked address, so the host is not resolved again between the check and the request. */
export function bitbucketFetch(fetchImpl: typeof fetch, instance: Instance, token: string): BitbucketFetch {
  const named = new URL(instance.baseUrl);
  const pinned = new URL(instance.baseUrl);
  pinned.hostname = instance.address.includes(":") ? `[${instance.address}]` : instance.address;
  const pinnedBase = `${pinned.origin}${pinned.pathname.replace(/\/+$/, "")}`;
  // Certificates are checked against the name, not the address.
  const tls = named.protocol === "https:" && addressOf(named.hostname) === undefined ? { tls: { serverName: named.hostname } } : {};
  return function withToken(path, init) {
    const headers = new Headers(init?.headers);
    headers.set("host", named.host);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    // A form sets its own content type, with the boundary its parts are split on.
    if (init?.body !== undefined && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
    return fetchImpl(`${pinnedBase}${path}`, { ...init, headers, redirect: "manual", ...tls });
  };
}

// The token reaches public unicast addresses only. An operator allowlist may name a host whose addresses are private or
// loopback; it cannot unlock the rest.
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata"]);
// EC2 IPv6 instance metadata sits inside the otherwise allowlistable fc00::/7.
const EC2_METADATA = ipaddr.parse("fd00:ec2::254").toString();
// ipaddr.js names site-local fec0::/10 and IPv4-compatible ::a.b.c.d "unicast"; public IPv6 is global unicast only.
const GLOBAL_UNICAST = ipaddr.parseCIDR("2000::/3");
const ALLOWLISTABLE = new Set(["private", "uniqueLocal", "loopback"]);

type AddressKind = "public" | "allowlistable" | "refused";

/** The literal address a host names, with IPv4-mapped IPv6 unwrapped; undefined for a name. */
function addressOf(host: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const bare = host.replace(/^\[|\]$/g, "");
  return ipaddr.isValid(bare) ? ipaddr.process(bare) : undefined;
}

function kindOf(address: ipaddr.IPv4 | ipaddr.IPv6): AddressKind {
  const range = address.range();
  if (range === "unicast") {
    if (address instanceof ipaddr.IPv6 && !address.match(GLOBAL_UNICAST)) return "refused";
    return "public";
  }
  if (address.toString() === EC2_METADATA) return "refused";
  return ALLOWLISTABLE.has(range) ? "allowlistable" : "refused";
}

function hostKey(host: string): string {
  const address = addressOf(host);
  return address === undefined ? host.toLowerCase().replace(/\.+$/, "") : address.toString();
}

function allowlisted(host: string, allowlist: readonly string[]): boolean {
  const key = hostKey(host);
  return allowlist.some((entry) => hostKey(entry) === key);
}

function permitted(address: ipaddr.IPv4 | ipaddr.IPv6, listed: boolean): boolean {
  const kind = kindOf(address);
  return kind === "public" || (listed && kind === "allowlistable");
}

/**
 * An http(s) URL without credentials, query or fragment, kept with its context path
 * (an instance can live under one) and without a trailing slash. The host is not checked.
 */
export function instanceUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** An instance URL whose host is not a metadata name and, when a literal address, one the token may reach. */
function instanceBaseUrl(value: string, allowlist: readonly string[] = []): string | undefined {
  const baseUrl = instanceUrl(value);
  if (baseUrl === undefined) return undefined;
  const { hostname } = new URL(baseUrl);
  if (METADATA_HOSTS.has(hostKey(hostname))) return undefined;
  const address = addressOf(hostname);
  if (address !== undefined && !permitted(address, allowlisted(hostname, allowlist))) return undefined;
  return baseUrl;
}

export type AddressLookup = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

export function lookupAddresses(hostname: string): Promise<readonly { address: string; family: number }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/** A checked instance: `address` is what its host resolved to, and every request goes there. */
export type Instance = { baseUrl: string; address: string };

/** Resolved once; undefined when the URL is refused, the lookup fails, or any address is one the token may not reach. */
export async function resolveInstance(value: string, lookup: AddressLookup, allowlist: readonly string[] = []): Promise<Instance | undefined> {
  const baseUrl = instanceBaseUrl(value, allowlist);
  if (baseUrl === undefined) return undefined;
  const { hostname } = new URL(baseUrl);
  const literal = addressOf(hostname);
  if (literal !== undefined) return { baseUrl, address: literal.toString() };
  let answers: readonly { address: string }[];
  try {
    answers = await lookup(hostname);
  } catch {
    return undefined;
  }
  const listed = allowlisted(hostname, allowlist);
  const addresses = answers.map((answer) => addressOf(answer.address));
  if (addresses.length === 0 || !addresses.every((address) => address !== undefined && permitted(address, listed))) return undefined;
  // Only the pinned address is tried, with no fallback to another answer, so IPv4 goes first: a host without IPv6
  // egress cannot connect to an IPv6 answer.
  const pinned = addresses.find((address) => address?.kind() === "ipv4") ?? addresses[0]!;
  return { baseUrl, address: pinned.toString() };
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

function webhookBody(url: string, secret: string): string {
  return JSON.stringify({ name: "Corbits Triage", url, active: true, events: WEBHOOK_EVENTS, configuration: { secret } });
}

/** The new webhook's id, or undefined when the token may not manage the repository's webhooks. */
export async function createWebhook(bb: BitbucketFetch, project: string, slug: string, url: string, secret: string): Promise<number | undefined> {
  const path = `${repoPath(project, slug)}/webhooks`;
  const res = await bb(path, { method: "POST", body: webhookBody(url, secret) });
  if (res.status === 401 || res.status === 403) return undefined;
  if (!res.ok) throw new BitbucketFailed(res.status, path);
  return Webhook.assert(await res.json()).id;
}

/** Saves the webhook triage created again, signing with `secret` from now on. */
export async function saveWebhook(bb: BitbucketFetch, project: string, slug: string, id: number, url: string, secret: string): Promise<void> {
  const path = `${repoPath(project, slug)}/webhooks/${id}`;
  const res = await bb(path, { method: "PUT", body: webhookBody(url, secret) });
  if (!res.ok) throw new BitbucketFailed(res.status, path);
}

export async function deleteWebhook(bb: BitbucketFetch, project: string, slug: string, id: number): Promise<void> {
  const path = `${repoPath(project, slug)}/webhooks/${id}`;
  const res = await bb(path, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new BitbucketFailed(res.status, path);
}
