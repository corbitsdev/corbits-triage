import { repoPolicy, type RepoSource } from "@corbits/triage-contracts";
import type { PackState } from "./check-packs.ts";
import type { OpenPulls, PrItem, RepoRecord } from "./hub-api.ts";
import { inboxAction, inNeedsYou, UNASSIGNED } from "./inbox-view.ts";
import { hasRuleOn } from "./pack-draft.ts";

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

/** Repositories whose policy cannot run: refused, missing, unreadable or with no rule on. One still loading or failing to load is not named. */
export function reposNeedingSetup(packs: ReadonlyMap<string, PackState>): Set<string> {
  const needing = [...packs].filter(([, state]) => !state.pending && state.error === null && !policyRuns(state));
  return new Set(needing.map(([repo]) => repo));
}

export function packsPending(packs: ReadonlyMap<string, PackState>): boolean {
  return [...packs.values()].some((state) => state.pending);
}

/** The stored repositories, then the Bitbucket Data Center repositories not recorded yet. */
export function mergeRepositories(stored: RepoRecord[], listed: RepoRecord[] | undefined): RepoRecord[] {
  const names = new Set(stored.map((repo) => repo.name));
  return [...stored, ...(listed ?? []).filter((repo) => !names.has(repo.name))];
}

export function triageEnabledRepos(repos: RepoRecord[]): Set<string> {
  return new Set(repos.filter((repo) => repoPolicy(repo).enabled).map((repo) => repo.name));
}

export function triageReadyRepos(repos: RepoRecord[], packs: ReadonlyMap<string, PackState>): Set<string> {
  return new Set(repos.filter((repo) => repoPolicy(repo).enabled && policyRuns(packs.get(repo.name))).map((repo) => repo.name));
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
  active: ReadonlySet<string>,
  catchingUp: Set<string>,
  openPulls: OpenPulls | undefined,
  pullsError: Error | null,
): RepoRow[] {
  const needsSetup = reposNeedingSetup(packs);
  const ready = triageReadyRepos(repos, packs);
  const errors = new Map(openPulls?.repos.flatMap((row) => (row.error ? [[row.repo, row.error] as const] : [])));
  return repos.map(function repoRow(repo) {
    const { enabled } = repoPolicy(repo);
    const error = pullsError?.message ?? errors.get(repo.name);
    return {
      name: repo.name,
      source: repo.source,
      href: `/repositories/${repo.name}`,
      pulls: error === undefined ? pullsOf(items.filter((item) => item.repo === repo.name), ready.has(repo.name)) : { error },
      health: repoHealth({ needsSetup: needsSetup.has(repo.name), enabled, catchingUp: catchingUp.has(repo.name), receivingEvents: active.has(repo.name) }),
    };
  });
}
