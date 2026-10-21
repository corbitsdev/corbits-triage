// Open pull requests for the workspace's connected repositories, read through
// the tenant's vaulted GitHub App credential so the portal never calls GitHub.
import { eq } from "drizzle-orm";
import { schema } from "@intx/db";
import { authorAssociation, authorKindOf, type AuthorKind, type RepoSource } from "@corbits/triage-contracts";
import { INSTALLATION_SELECTOR_HEADER, listOpenPrs, type GithubFetch } from "@corbits/github-reads";
import { errorText } from "@corbits/common";
import { failure, refusalResponse, sourceCredentialRefusal, type CredentialRefusal, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";

export const GITHUB_OPEN_PULLS_PATH = "/api/integrations/github-open-pulls";

type GithubOpenPr = Awaited<ReturnType<typeof listOpenPrs>>[number];
type OpenPr = Omit<GithubOpenPr, "authorAssociation" | "authorBot"> & { authorKind?: AuthorKind };
/** `source` names the host the pull requests and their `url` are on. */
export type RepoPulls = { repo: string; source: RepoSource; prs: OpenPr[]; error?: string };

function withAuthorKind({ authorAssociation: association, authorBot, ...pr }: GithubOpenPr): OpenPr {
  const authorKind = authorKindOf(authorAssociation(association), authorBot);
  return authorKind === undefined ? pr : { ...pr, authorKind };
}

export function forInstallation(gh: GithubFetch, installationId: number | undefined): GithubFetch {
  if (installationId === undefined) return gh;
  return function installationFetch(path, init) {
    const headers = new Headers(init?.headers);
    headers.set(INSTALLATION_SELECTOR_HEADER, String(installationId));
    return gh(path, { ...init, headers });
  };
}

/** Lists one repository's open pull requests on its host; GitHub's through the tenant's App, another host's through its reader. */
export type OpenPrsLister = (tenantId: string, record: RepoRecord) => Promise<GithubOpenPr[]>;

async function pullsFor(list: OpenPrsLister, tenantId: string, record: RepoRecord): Promise<RepoPulls> {
  const source = sourceOf(record);
  try {
    const prs = await list(tenantId, record);
    return { repo: record.name, source, prs: prs.map(withAuthorKind) };
  } catch (err) {
    return { repo: record.name, source, prs: [], error: errorText(err) };
  }
}

function listRepoPulls(list: OpenPrsLister, tenantId: string, records: readonly RepoRecord[]): Promise<RepoPulls[]> {
  return Promise.all(records.map((record) => pullsFor(list, tenantId, record)));
}

export type SourceRefusal = CredentialRefusal & { source: RepoSource };

/** The hosts among the records whose credential the member may not read, each with why; a host with no record needs nothing. */
export async function refusedSources(deps: PortalCredentialDeps, member: Member, records: readonly RepoRecord[]): Promise<SourceRefusal[]> {
  const refused: SourceRefusal[] = [];
  for (const source of new Set(records.map(sourceOf))) {
    const refusal = await sourceCredentialRefusal(deps, member.principalId, member.tenantId, { source }, "read");
    if (refusal) refused.push({ source, ...refusal });
  }
  return refused;
}

/**
 * The refusal to answer with. Any 403 refuses outright: the listing is shared by the workspace, so a member barred from one host
 * neither sees it nor writes it. A host with no credential is the same for every member and costs only its own repositories,
 * unless no host among the records has one.
 */
export function listingRefusal(records: readonly RepoRecord[], refused: readonly SourceRefusal[]): Response | undefined {
  const forbidden = refused.find((refusal) => refusal.status === 403);
  if (forbidden) return refusalResponse(forbidden);
  const [first] = refused;
  const unconnected = new Set(refused.map((refusal) => refusal.source));
  return first && records.every((record) => unconnected.has(sourceOf(record))) ? refusalResponse(first) : undefined;
}

/** Lists the records of every host with a credential; each repository of a host without one is an error row. */
export async function listConnectedPulls(list: OpenPrsLister, tenantId: string, records: readonly RepoRecord[], unconnected: readonly SourceRefusal[]): Promise<RepoPulls[]> {
  const messages = new Map(unconnected.map((refusal) => [refusal.source, refusal.message]));
  const listed = await listRepoPulls(list, tenantId, records.filter((record) => !messages.has(sourceOf(record))));
  const skipped = records.filter((record) => messages.has(sourceOf(record))).map((record): RepoPulls => ({ repo: record.name, source: sourceOf(record), prs: [], error: messages.get(sourceOf(record)) }));
  return [...listed, ...skipped];
}

export type OpenPullsRead = { at: number; repos: RepoPulls[] };

/** GitHub's last listing of each tenant's open pull requests, shared by the portal's listing and the verdict route. */
export type OpenPullsCache = {
  kept(tenantId: string, maxAgeMs: number): OpenPullsRead | undefined;
  /** Lists now and keeps the listing; callers while it is read share it. */
  read(tenantId: string, list: () => Promise<RepoPulls[]>): Promise<OpenPullsRead>;
};

export function createOpenPullsCache(now: () => Date): OpenPullsCache {
  const kept = new Map<string, OpenPullsRead>();
  const reading = new Map<string, Promise<OpenPullsRead>>();

  async function readOnce(tenantId: string, list: () => Promise<RepoPulls[]>): Promise<OpenPullsRead> {
    try {
      const listed = { at: now().getTime(), repos: await list() };
      kept.set(tenantId, listed);
      return listed;
    } finally {
      reading.delete(tenantId);
    }
  }

  return {
    kept(tenantId, maxAgeMs) {
      const listed = kept.get(tenantId);
      return listed && now().getTime() - listed.at < maxAgeMs ? listed : undefined;
    },
    read(tenantId, list) {
      const pending = reading.get(tenantId) ?? readOnce(tenantId, list);
      reading.set(tenantId, pending);
      return pending;
    },
  };
}

/** A listing this young is answered again rather than asking GitHub, so the portal, the verdict route and the policy standings share one read. */
const RELIST_MS = 10_000;

export type MemberOpenPulls = (member: Member, fresh: boolean) => Promise<OpenPullsRead | Response>;

/** The workspace's open pull requests from the shared listing, listed again once it is `RELIST_MS` old or when `fresh`; the refusal when the member may not see it. */
export function createMemberOpenPulls(deps: PortalCredentialDeps & { list: OpenPrsLister; cache: OpenPullsCache }): MemberOpenPulls {
  return async function memberOpenPulls(member, fresh) {
    const { tenantId } = member;
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const connected = repoRecords(triageNs(tenant.config)).filter((record) => record.connected);
    const refused = await refusedSources(deps, member, connected);
    const refusal = listingRefusal(connected, refused);
    if (refusal) return refusal;
    const kept = fresh ? undefined : deps.cache.kept(tenantId, RELIST_MS);
    return kept ?? deps.cache.read(tenantId, () => listConnectedPulls(deps.list, tenantId, connected, refused));
  };
}

export function createGithubOpenPulls(deps: PortalCredentialDeps & { list: OpenPrsLister; cache: OpenPullsCache }) {
  const memberOpenPulls = createMemberOpenPulls(deps);
  return async function openPulls(member: Member): Promise<Response> {
    const listed = await memberOpenPulls(member, false);
    return listed instanceof Response ? listed : Response.json({ repos: listed.repos });
  };
}
