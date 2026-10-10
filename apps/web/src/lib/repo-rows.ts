import { repoPolicy } from "@corbits/triage-contracts";
import { repoNeedsCheckSetup } from "./check-pack.ts";
import { hasVerifiedWebhookDelivery } from "./connect-view.ts";
import type { OpenPulls, PrItem, RepoRecord, RunLog } from "./hub-api.ts";
import { inboxAction, UNASSIGNED } from "./inbox-view.ts";

export type RepoHealth = { tone: "ok" | "warn" | "idle"; label: string };

export function repoHealth(state: { needsSetup: boolean; enabled: boolean; catchingUp: boolean; receivingEvents: boolean }): RepoHealth {
  if (state.needsSetup) return { tone: "warn", label: "Needs setup" };
  if (!state.enabled) return { tone: "idle", label: "Disabled" };
  if (state.catchingUp) return { tone: "idle", label: "Catching up" };
  if (state.receivingEvents) return { tone: "ok", label: "Webhooks OK" };
  return { tone: "idle", label: "No events yet" };
}

function triageReady(repo: RepoRecord): boolean {
  return !repoNeedsCheckSetup(repo) && repoPolicy(repo).enabled;
}

export function triageEnabledRepos(repos: RepoRecord[]): Set<string> {
  return new Set(repos.filter((repo) => repoPolicy(repo).enabled).map((repo) => repo.name));
}

/** The repositories whose pull requests can be triaged. */
export function triageReadyRepos(repos: RepoRecord[]): Set<string> {
  return new Set(repos.filter(triageReady).map((repo) => repo.name));
}

/** What GitHub's open pull requests say about one repository, or why they could not be read. */
export type RepoPulls =
  | { open: number; needsYou: number; awaiting: number; owners: string[]; lastActivity: string | null }
  | { error: string };

export type RepoRow = {
  name: string;
  href: string;
  needsSetup: boolean;
  posting: "Ask me" | "Post automatically";
  pulls: RepoPulls;
  health: RepoHealth;
};

function newest(times: Array<string | null>): string | null {
  return times.reduce<string | null>((latest, at) => (at && (!latest || Date.parse(at) > Date.parse(latest)) ? at : latest), null);
}

/** Needs you is the inbox's pile for the repository; the rest wait for a first verdict, but only once the repository can be triaged. */
function pullsOf(open: PrItem[], ready: boolean): RepoPulls {
  const actionable = open.filter((item) => inboxAction(item) !== null);
  return {
    open: open.length,
    needsYou: actionable.length,
    awaiting: ready ? open.length - actionable.length : 0,
    owners: [...new Set(actionable.map((item) => item.owner ?? UNASSIGNED))],
    lastActivity: newest(open.map((item) => item.updatedAt)),
  };
}

/** `items` are the open pull requests; `pullsError` is the open pull request listing's own failure. */
export function repoRows(
  repos: RepoRecord[],
  items: PrItem[],
  logs: RunLog[],
  catchingUp: Set<string>,
  openPulls: OpenPulls | undefined,
  pullsError: Error | null,
): RepoRow[] {
  const errors = new Map(openPulls?.repos.flatMap((row) => (row.error ? [[row.repo, row.error] as const] : [])));
  return repos.map(function repoRow(repo) {
    const needsSetup = repoNeedsCheckSetup(repo);
    const policy = repoPolicy(repo);
    const error = pullsError?.message ?? errors.get(repo.name);
    return {
      name: repo.name,
      href: `/repositories/${repo.name}`,
      needsSetup,
      posting: policy.cleanupMode === "automated" ? "Post automatically" : "Ask me",
      pulls: error === undefined ? pullsOf(items.filter((item) => item.repo === repo.name), triageReady(repo)) : { error },
      health: repoHealth({ needsSetup, enabled: policy.enabled, catchingUp: catchingUp.has(repo.name), receivingEvents: hasVerifiedWebhookDelivery(logs, repo.name) }),
    };
  });
}
