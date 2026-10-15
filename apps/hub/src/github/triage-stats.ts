// A repository's triage over a window of days, from the recorded verdicts, with
// the outcomes of the pull requests it triaged, read from the host and cached, so
// the portal and the extension can ask for it on every view.
import { type } from "arktype";
import { currentRows, parseCheckOutput, TriageStats } from "@corbits/triage-contracts";
import { failure } from "./portal-credential.js";
import type { OutcomeReader } from "./pr-outcomes.js";
import { runKey } from "./reconcile-plan.js";
import type { Member } from "../integrations/app.js";
import { evidenceOf, type VerdictRecord, type VerdictRecordStore } from "./verdict-record-store.js";

export const TRIAGE_STATS_PATH = "/api/integrations/triage-stats";

const DAY_MS = 86_400_000;
const CACHE_MS = 60_000;
const CACHE_ENTRIES = 1_000;
const DEFAULT_DAYS = 7;
const MAX_OUTCOMES = 50;

const StatsQuery = type({
  repo: /^[\w.-]+\/[\w.-]+$/,
  "days?": type("string.integer.parse").to("1 <= number.integer <= 30"),
});

export type TriageStatsDeps = {
  verdicts: Pick<VerdictRecordStore, "since" | "earliest">;
  outcomes: OutcomeReader;
  now: () => Date;
};

const EXECUTED = new Set(["done", "satisfied"]);

function latestPerHead(verdicts: readonly VerdictRecord[]): VerdictRecord[] {
  return [...new Map(verdicts.map((verdict) => [runKey(verdict.number, verdict.headSha), verdict])).values()];
}

function count<K extends string>(into: Record<string, Record<K, number>>, id: string, empty: Record<K, number>, field: K): void {
  const entry = (into[id] ??= { ...empty });
  entry[field] += 1;
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The window is `days` whole UTC days, today included, so the daily counts cover all of it. */
function windowStart(now: Date, days: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * DAY_MS);
}

/** A verdict counts once its run completed; one recorded before runs' ends were was of a completed run. */
function completed(verdict: VerdictRecord): boolean {
  return verdict.runStatus === null || verdict.runStatus === "completed";
}

type RanDo = { kind: string | undefined; status: string };

/** Each Do a run wrote, found written or failed to write, by effect id, as its verdict recorded it. */
function ranDos(records: readonly VerdictRecord[]): Map<string, RanDo> {
  const ran = new Map<string, RanDo>();
  for (const verdict of records) {
    for (const { effectId, kind, status } of verdict.detail?.actions ?? []) {
      if (effectId !== undefined && status !== undefined) ran.set(effectId, { kind, status });
    }
  }
  return ran;
}

/** Degraded verdicts are left out: they judged nothing; so are those of runs still going or that failed or were cancelled. */
function judgedOf(records: readonly VerdictRecord[]): VerdictRecord[] {
  return records.filter((verdict) => verdict.degraded === null && completed(verdict));
}

/** The pull requests of the newest settled verdicts, whose outcomes are read from the host. */
function newestTriaged(records: readonly VerdictRecord[]): number[] {
  const settled = judgedOf(records).filter((verdict) => verdict.settled).toSorted((a, b) => b.verdictAt.getTime() - a.verdictAt.getTime());
  return [...new Set(settled.map((verdict) => verdict.number))].slice(0, MAX_OUTCOMES);
}

function aggregate(repo: string, days: number, from: Date, since: Date | null, records: readonly VerdictRecord[]): Omit<TriageStats, "outcomes"> {
  const judged = judgedOf(records);
  const latest = latestPerHead(judged);
  const settled = judged.filter((verdict) => verdict.settled);

  const verdicts: Record<string, number> = {};
  for (const verdict of latest) verdicts[verdict.state] = (verdicts[verdict.state] ?? 0) + 1;

  const checks: TriageStats["checks"] = {};
  const empty = { pass: 0, fail: 0, unconfirmed: 0 };
  for (const verdict of latest) {
    for (const { check, result } of verdict.checks) {
      if (result !== "pass" && result !== "fail" && result !== "unconfirmed") continue;
      for (const row of currentRows(check, evidenceOf(verdict, check))) count(checks, row.check, empty, result);
    }
    for (const { check, output } of verdict.detail?.checks ?? []) {
      const rated = parseCheckOutput(output);
      if (rated?.kind !== "level" || !checks[check]) continue;
      const levels = (checks[check].levels ??= {});
      levels[rated.level] = (levels[rated.level] ?? 0) + 1;
    }
  }

  const actions: TriageStats["actions"] = {};
  const actionOf = new Map<string, string>();
  const none = { suggested: 0, executed: 0, failed: 0 };
  for (const verdict of judged) {
    for (const { list, effectId } of verdict.dos) {
      if (list === undefined || actionOf.has(effectId)) continue;
      actionOf.set(effectId, list);
      count(actions, list, none, "suggested");
    }
  }
  const ran = ranDos(records);
  for (const [effectId, { status }] of ran) {
    const list = actionOf.get(effectId);
    if (list === undefined) continue;
    if (EXECUTED.has(status)) count(actions, list, none, "executed");
    else if (status === "failed") count(actions, list, none, "failed");
  }

  const triagedOn = new Map<string, Set<number>>();
  for (const verdict of settled) {
    const date = day(verdict.verdictAt);
    triagedOn.set(date, (triagedOn.get(date) ?? new Set()).add(verdict.number));
  }
  const daily = Array.from({ length: days }, function dayOf(_, i) {
    const date = day(new Date(from.getTime() + i * DAY_MS));
    return { date, triaged: triagedOn.get(date)?.size ?? 0 };
  });

  return {
    repo,
    days,
    since: since?.toISOString() ?? null,
    triaged: new Set(settled.map((verdict) => verdict.number)).size,
    verdicts,
    neededYou: new Set(latest.filter((verdict) => verdict.actor === "maintainer" || verdict.humanGated).map((verdict) => verdict.number)).size,
    checks,
    actions,
    comments: records.filter((verdict) => verdict.commented).length + [...ran.values()].filter((action) => action.kind === "comment" && action.status === "done").length,
    daily,
  };
}

type Aggregate = { stats: Omit<TriageStats, "outcomes">; triaged: number[] };

/** The aggregate is cached per repository; the outcomes are read per request, since they depend on the member's grants. */
export function createTriageStats(deps: TriageStatsDeps) {
  const cache = new Map<string, Aggregate & { at: number }>();

  function cached(key: string, now: number): Aggregate | undefined {
    for (const [stale, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(stale);
    return cache.get(key);
  }

  async function aggregated(tenantId: string, repo: string, days: number, now: Date): Promise<Aggregate> {
    const key = `${tenantId}\n${repo}\n${days}`;
    const hit = cached(key, now.getTime());
    if (hit) return hit;
    const from = windowStart(now, days);
    const [records, since] = await Promise.all([deps.verdicts.since(tenantId, repo, from), deps.verdicts.earliest(tenantId, repo)]);
    const entry = { at: now.getTime(), stats: aggregate(repo, days, from, since, records), triaged: newestTriaged(records) };
    if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(key, entry);
    return entry;
  }

  return async function handle(req: Request, member: Member): Promise<Response> {
    const query = StatsQuery(Object.fromEntries(new URL(req.url).searchParams));
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    const { repo, days = DEFAULT_DAYS } = query;
    const { stats, triaged } = await aggregated(member.tenantId, repo, days, deps.now());
    return Response.json({ ...stats, outcomes: await deps.outcomes(member, repo, triaged) } satisfies TriageStats);
  };
}
