import { repoPolicy } from "@corbits/triage-contracts";
import { isRepoCatchingUp } from "./backlog-status.ts";
import { repoNeedsCheckSetup } from "./check-pack.ts";
import { hasVerifiedWebhookDelivery } from "./connect-view.ts";
import type { HubRun, OpenPulls, PrItem, RepoRecord, RunLog } from "./hub-api.ts";

export type RepoHealth = { tone: "ok" | "warn" | "idle"; label: string };

export type RepoRow = {
  name: string;
  href: string;
  needsSetup: boolean;
  open: number;
  needsYou: number;
  posting: "Ask me" | "Post automatically";
  owners: string[];
  /** Undefined until GitHub's open pull requests for this repository have loaded. */
  lastActivity: string | null | undefined;
  health: RepoHealth;
};

function repoHealth(repo: RepoRecord, logs: RunLog[], runs: HubRun[]): RepoHealth {
  if (repoNeedsCheckSetup(repo)) return { tone: "warn", label: "Needs setup" };
  if (!repoPolicy(repo).enabled) return { tone: "idle", label: "Disabled" };
  if (isRepoCatchingUp(logs, runs, repo.name)) return { tone: "idle", label: "Catching up" };
  if (hasVerifiedWebhookDelivery(logs, repo.name)) return { tone: "ok", label: "Webhooks OK" };
  return { tone: "idle", label: "No webhooks yet" };
}

function newest(times: Array<string | null>): string | null {
  return times.reduce<string | null>((latest, at) => (at && (!latest || Date.parse(at) > Date.parse(latest)) ? at : latest), null);
}

export function repoRows(repos: RepoRecord[], items: PrItem[], logs: RunLog[], runs: HubRun[], openPulls: OpenPulls | undefined): RepoRow[] {
  const listed = new Set(openPulls?.repos.filter((row) => !row.error).map((row) => row.repo));
  return repos.map(function repoRow(repo) {
    const needsSetup = repoNeedsCheckSetup(repo);
    const open = items.filter((item) => item.repo === repo.name && !item.closed);
    return {
      name: repo.name,
      href: `/repositories/${encodeURIComponent(repo.name)}${needsSetup ? "/setup" : ""}`,
      needsSetup,
      open: open.length,
      needsYou: open.filter((item) => item.needsHuman).length,
      posting: repoPolicy(repo).cleanupMode === "automated" ? "Post automatically" : "Ask me",
      owners: [...new Set(open.flatMap((item) => (item.owner ? [item.owner] : [])))],
      lastActivity: listed.has(repo.name) ? newest(open.map((item) => item.updatedAt)) : undefined,
      health: repoHealth(repo, logs, runs),
    };
  });
}
