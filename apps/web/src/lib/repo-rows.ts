import { REPO_SOURCES, repoPolicy, repoSourceOf, type RepoSource } from "@corbits/triage-contracts";
import type { PackState } from "./check-packs.ts";
import type { OpenPulls, PrItem, RepoRecord } from "./hub-api.ts";
import { inboxAction, inNeedsYou, UNASSIGNED } from "./inbox-view.ts";
import { hasRuleOn } from "./pack-rules.ts";

export type RepoHealth = { tone: "ok" | "warn" | "idle"; label: string };

export function repoHealth(state: { needsSetup: boolean; enabled: boolean; catchingUp: boolean; receivingEvents: boolean }): RepoHealth {
  if (state.needsSetup) return { tone: "warn", label: "Needs setup" };
  if (!state.enabled) return { tone: "idle", label: "Disabled" };
  if (state.catchingUp) return { tone: "idle", label: "Catching up" };
  if (state.receivingEvents) return { tone: "ok", label: "Webhooks OK" };
  return { tone: "idle", label: "No events yet" };
}

function policyRuns(state: PackState | undefined): boolean {
  const found = state?.found;
  return found !== undefined && found !== null && "pack" in found && hasRuleOn(found.pack);
}

/** A policy that cannot run: refused, missing, unreadable or with no rule on. One still loading or failing to load is not. */
function needsSetup(state: PackState | undefined): boolean {
  return state !== undefined && !state.pending && state.error === null && !policyRuns(state);
}

export function reposNeedingSetup(repos: RepoRecord[], packs: ReadonlyMap<string, PackState>): Set<string> {
  return new Set(repos.filter((repo) => needsSetup(packs.get(repoKey(repo)))).map((repo) => repo.name));
}

export function packsPending(packs: ReadonlyMap<string, PackState>): boolean {
  return [...packs.values()].some((state) => state.pending);
}

/** A repository is its host and its name; the same name can be connected from both hosts, and no host means GitHub. */
export type RepoId = { name: string; source?: RepoSource };

export function sameRepo(a: RepoId, b: RepoId): boolean {
  return a.name === b.name && repoSourceOf(a.source) === repoSourceOf(b.source);
}

/** The key a repository's entry in a map such as `useCheckPacks` sits under. */
export function repoKey(repo: RepoId): string {
  return `${repoSourceOf(repo.source)}:${repo.name}`;
}

/** The hub names a repository on its host as `{ repo, source }`. */
export function hostedRepos(rows: ReadonlyArray<{ repo: string; source: RepoSource }>): RepoId[] {
  return rows.map(({ repo, source }) => ({ name: repo, source }));
}

/** A GitHub repository's link carries no host, so links from before Bitbucket Data Center still open it. */
export function repoHref(repo: RepoId): string {
  return repo.source === "bitbucket-datacenter" ? `/repositories/${repo.name}?source=${repo.source}` : `/repositories/${repo.name}`;
}

/** The repository a link names; `source` is null on a link without a host. */
type RepoLink = { name: string; source: RepoSource | null };

/** `/repositories/owner/name[?source=host]`; the older `/repositories/owner%2Fname[/setup]` links arrive with the slash inside the first segment and move to the new form. */
export function selectedRepo(params: { owner?: string; repo?: string }, search: URLSearchParams): { repo: RepoLink | null; redirect: string | null } {
  if (params.owner?.includes("/")) return { repo: null, redirect: `/repositories/${params.owner}` };
  const source = search.get("source");
  if (source !== null && !(REPO_SOURCES as readonly string[]).includes(source)) return { repo: null, redirect: "/repositories" };
  if (params.owner && params.repo) return { repo: { name: `${params.owner}/${params.repo}`, source: source === null ? null : repoSourceOf(source) }, redirect: null };
  return { repo: null, redirect: params.owner === undefined ? null : "/repositories" };
}

/** A link without a host predates Bitbucket Data Center: it opens the GitHub repository of that name, else the only one. */
export function findRepo<T extends RepoId>(rows: T[], link: RepoLink | null): T | undefined {
  if (link === null) return undefined;
  const { name, source } = link;
  if (source !== null) return rows.find((row) => sameRepo(row, { name, source }));
  const named = rows.filter((row) => row.name === name);
  return named.find((row) => repoSourceOf(row.source) === "github") ?? (named.length === 1 ? named[0] : undefined);
}

/** The stored repositories, then the Bitbucket Data Center repositories not recorded yet. */
export function mergeRepositories(stored: RepoRecord[], listed: RepoRecord[] | undefined): RepoRecord[] {
  return [...stored, ...(listed ?? []).filter((repo) => !stored.some((row) => sameRepo(row, repo)))];
}

export function enabledRepos(repos: RepoRecord[]): RepoRecord[] {
  return repos.filter((repo) => repoPolicy(repo).enabled);
}

export function triageEnabledRepos(repos: RepoRecord[]): Set<string> {
  return new Set(enabledRepos(repos).map((repo) => repo.name));
}

export function triageReadyRepos(repos: RepoRecord[], packs: ReadonlyMap<string, PackState>): Set<string> {
  return new Set(enabledRepos(repos).filter((repo) => policyRuns(packs.get(repoKey(repo)))).map((repo) => repo.name));
}

type RepoPulls =
  | { open: number; needsYou: number; awaiting: number; owners: string[]; lastActivity: string | null }
  | { error: string };

export type RepoRow = {
  name: string;
  source: RepoSource;
  href: string;
  pulls: RepoPulls;
  health: RepoHealth;
};

function newest(times: Array<string | null>): string | null {
  return times.reduce<string | null>((latest, at) => (at && (!latest || Date.parse(at) > Date.parse(latest)) ? at : latest), null);
}

/** Needs you is the inbox's pile for the repository; the rest wait for a first verdict, but only once the repository can be triaged. */
function pullsOf(open: PrItem[], ready: boolean): RepoPulls {
  const actionable = open.filter(inNeedsYou);
  return {
    open: open.length,
    needsYou: actionable.length,
    awaiting: ready ? open.filter((item) => inboxAction(item) === null).length : 0,
    owners: [...new Set(actionable.map((item) => item.owner ?? UNASSIGNED))],
    lastActivity: newest(open.map((item) => item.updatedAt)),
  };
}

/** `packs` are the repositories' policies; `items` the open pull requests; `active` the repositories with a verdict in the last 14 days or a run in flight; `pullsError` is the open pull request listing's own failure. */
export function repoRows(
  repos: RepoRecord[],
  packs: ReadonlyMap<string, PackState>,
  items: PrItem[],
  active: readonly RepoId[],
  catchingUp: readonly RepoId[],
  openPulls: OpenPulls | undefined,
  pullsError: Error | null,
): RepoRow[] {
  return repos.map(function repoRow(repo) {
    const { enabled } = repoPolicy(repo);
    const listing = openPulls?.repos.find((row) => row.error !== undefined && sameRepo({ name: row.repo, source: row.source }, repo));
    const error = pullsError?.message ?? listing?.error;
    const open = items.filter((item) => sameRepo({ name: item.repo, source: item.source }, repo));
    const pack = packs.get(repoKey(repo));
    return {
      name: repo.name,
      source: repo.source,
      href: repoHref(repo),
      pulls: error === undefined ? pullsOf(open, enabled && policyRuns(pack)) : { error },
      health: repoHealth({ needsSetup: needsSetup(pack), enabled, catchingUp: catchingUp.some((row) => sameRepo(row, repo)), receivingEvents: active.some((row) => sameRepo(row, repo)) }),
    };
  });
}
