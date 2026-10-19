import { asRecord } from "@corbits/common";
import { repoPolicy } from "@corbits/triage-contracts";
import { repoRecords, type CorbitsTriageNs, type RepoRecord } from "../github/tenant-config.js";
import { instanceUrl } from "./client.js";
import { PROVIDER, TOKEN_CREDENTIAL, HOOK_CREDENTIAL } from "./names.js";
export { PROVIDER, TOKEN_CREDENTIAL, HOOK_CREDENTIAL };

/** `user` is the slug the token acts as, recorded at connect; a connection recorded before it has none. */
type BitbucketConnection = { baseUrl: string; user?: string };

/** The stored connection; its host is checked where the token is sent (`resolveInstance`). */
export function bitbucketConnection(ns: CorbitsTriageNs): BitbucketConnection | undefined {
  const connection = asRecord(ns.bitbucketDatacenter);
  const stored = connection?.["baseUrl"];
  const user = connection?.["user"];
  const baseUrl = typeof stored === "string" ? instanceUrl(stored) : undefined;
  return baseUrl === undefined ? undefined : { baseUrl, ...(typeof user === "string" && { user }) };
}

export function bitbucketRepoName(project: string, slug: string): string {
  return `${project}/${slug}`;
}

export function splitName(name: string): [project: string, slug: string] {
  const at = name.indexOf("/");
  return [name.slice(0, at), name.slice(at + 1)];
}

export function isBitbucketRecord(record: RepoRecord): boolean {
  return record.source === "bitbucket-datacenter";
}

function newRecord(name: string): RepoRecord {
  return { name, connected: true, source: "bitbucket-datacenter", ...repoPolicy(undefined) };
}

/** The instance's repositories with their stored records; a stored one the token no longer sees stays listed, disconnected. */
export function listedRepos(ns: CorbitsTriageNs, names: readonly string[]): RepoRecord[] {
  const stored = repoRecords(ns).filter(isBitbucketRecord);
  const byName = new Map(stored.map((record) => [record.name, record]));
  const seen = new Set(names);
  function listed(name: string): RepoRecord {
    const record = byName.get(name);
    return record ? { ...record, connected: true } : newRecord(name);
  }
  const gone = stored.filter((record) => !seen.has(record.name)).map((record) => ({ ...record, connected: false }));
  return [...names.map(listed), ...gone];
}

export function enableRepo(ns: CorbitsTriageNs, name: string, defaultBranch: string, webhookId: number | undefined): CorbitsTriageNs {
  const repos = repoRecords(ns);
  const prev = repos.find((record) => isBitbucketRecord(record) && record.name === name);
  const { webhookId: _previous, ...base } = prev ?? newRecord(name);
  const record: RepoRecord = { ...base, connected: true, source: "bitbucket-datacenter", defaultBranch, enabled: true, ...(webhookId !== undefined && { webhookId }) };
  return { ...ns, repos: prev ? repos.map((row) => (row === prev ? record : row)) : [...repos, record] };
}

export function disableRepo(ns: CorbitsTriageNs, name: string): CorbitsTriageNs {
  return { ...ns, repos: repoRecords(ns).map((row) => (isBitbucketRecord(row) && row.name === name ? withoutWebhook({ ...row, enabled: false }) : row)) };
}

function withoutWebhook(record: RepoRecord): RepoRecord {
  const { webhookId: _webhookId, ...rest } = record;
  return rest;
}

/** The connection goes and every Bitbucket repository is disabled and disconnected, so nothing refers to the gone credential; their records stay so reconnecting keeps their settings. */
export function disconnect(ns: CorbitsTriageNs): CorbitsTriageNs {
  const { bitbucketDatacenter: _bitbucketDatacenter, ...rest } = ns;
  return { ...rest, repos: repoRecords(ns).map((row) => (isBitbucketRecord(row) ? withoutWebhook({ ...row, enabled: false, connected: false }) : row)) };
}
