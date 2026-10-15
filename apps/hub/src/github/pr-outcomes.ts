// How pull requests fared, read live from the repository's host for the stats route: time to merge or close, to the
// first response and approval from someone other than the author, and the longest wait between people's touches. The
// baseline is the same over pull requests closed before the repository's policy was first saved, when triage began.
import { eq } from "drizzle-orm";
import { schema } from "@intx/db";
import type { ArtifactDb } from "@corbits/artifacts";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { getPrTimes, listPrTimeline, searchClosedPrsBefore, type PrTimes, type TimelineEvent } from "@corbits/github-reads";
import { errorText } from "@corbits/common";
import type { OutcomeMedians, TriageOutcomes } from "@corbits/triage-contracts";
import { bitbucketConnection } from "../bitbucket-datacenter/records.js";
import { repoPolicyRow } from "./check-pack-store.js";
import { sourceCredentialGrant } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { createSourceFetch, type SourceFetchDeps } from "./source-fetch.js";
import { repoRecords, triageNs } from "./tenant-config.js";

const DAY_MS = 86_400_000;
const OPEN_MS = 15 * 60_000;
const CACHE_ENTRIES = 1_000;
const HOST_READS = 8;
/** Timeline events that are someone acting on the pull request, as opposed to being mentioned, subscribed or labelled. */
const TOUCHES = new Set(["commented", "reviewed", "merged", "closed"]);

/** One repository's pull requests on its host; `botLogins` are accounts that act for a tool without being marked bots. */
export type Host = {
  prTimes: (number: number) => Promise<PrTimes>;
  timeline: (number: number) => Promise<TimelineEvent[]>;
  closedBefore: (before: Date) => Promise<PrTimes[]>;
  botLogins: readonly string[];
};

/** Undefined when the repository is not connected. */
type HostRead = { host: Host } | { state: "no_credential" } | undefined;

export type OutcomeReaderDeps = {
  host: (tenantId: string, principalId: string, repo: string) => Promise<HostRead>;
  /** When the repository's policy was first saved; undefined without one. */
  enabledAt: (tenantId: string, repo: string) => Promise<Date | undefined>;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/** What a member is answered instead of the outcomes: null when the repository is not connected, undefined when they may read it. */
type Refusal = { state: "no_credential" } | null | undefined;

export type OutcomeReader = {
  refusal: (member: Member, repo: string) => Promise<Refusal>;
  read: (member: Member, repo: string, triaged: readonly number[]) => Promise<TriageOutcomes | null>;
};

type Outcome = {
  closed: boolean;
  mergeOrCloseMs: number | null;
  firstHumanResponseMs: number | null;
  firstApprovalMs: number | null;
  humanTouchGapMs: number | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Opening the pull request is the author's first touch. */
export function outcomeOf(pr: PrTimes, events: readonly TimelineEvent[], { author, botLogins }: { author: string | null; botLogins: readonly string[] }): Outcome {
  const opened = Date.parse(pr.createdAt);
  const people = events.filter((event) => TOUCHES.has(event.kind) && !event.bot && !botLogins.includes(event.actor)).toSorted((a, b) => a.at.localeCompare(b.at));
  const others = people.filter((event) => event.actor !== author);
  const approval = others.find((event) => event.kind === "reviewed" && event.state === "APPROVED");
  const touches = [opened, ...people.map((event) => Date.parse(event.at))];
  const gaps = touches.slice(1).map((at, i) => at - touches[i]!);
  return {
    closed: pr.closedAt !== null,
    mergeOrCloseMs: pr.closedAt === null ? null : Date.parse(pr.closedAt) - opened,
    firstHumanResponseMs: others[0] ? Date.parse(others[0].at) - opened : null,
    firstApprovalMs: approval ? Date.parse(approval.at) - opened : null,
    humanTouchGapMs: gaps.length === 0 ? null : Math.max(...gaps),
  };
}

function medianOf(outcomes: readonly Outcome[], field: Exclude<keyof Outcome, "closed">): number | null {
  return median(outcomes.flatMap((outcome) => (outcome[field] === null ? [] : [outcome[field]])));
}

function medians(outcomes: readonly Outcome[]): OutcomeMedians {
  return {
    prs: outcomes.length,
    closed: outcomes.filter((outcome) => outcome.closed).length,
    mergeOrCloseMs: medianOf(outcomes, "mergeOrCloseMs"),
    firstHumanResponseMs: medianOf(outcomes, "firstHumanResponseMs"),
    firstApprovalMs: medianOf(outcomes, "firstApprovalMs"),
    humanTouchGapMs: medianOf(outcomes, "humanTouchGapMs"),
  };
}

/** Runs at most `max` reads at once, the rest queued in order. */
function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limited<T>(read: () => Promise<T>): Promise<T> {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await read();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** Requests for a key share one load while it runs; a failed load is forgotten. The oldest entry goes first when full. */
function boundedCache<T>() {
  const entries = new Map<string, { expires: number; value: Promise<T> }>();
  return async function cached(key: string, now: number, load: () => Promise<T>, ttl?: (value: T) => number): Promise<T> {
    const hit = entries.get(key);
    if (hit && hit.expires > now) return hit.value;
    entries.delete(key);
    if (entries.size >= CACHE_ENTRIES) entries.delete(entries.keys().next().value!);
    const entry = { expires: Infinity, value: load() };
    entries.set(key, entry);
    try {
      const value = await entry.value;
      if (ttl) entry.expires = now + ttl(value);
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
    return entry.value;
  };
}

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

async function settledOutcomes(reads: readonly Promise<Outcome>[]): Promise<{ outcomes: Outcome[]; failed: number }> {
  const results = await Promise.allSettled(reads);
  const outcomes = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  return { outcomes, failed: results.length - outcomes.length };
}

type Baseline = { medians: OutcomeMedians | null; failed: number };

type MeasuredBaseline = Pick<Extract<TriageOutcomes, { state: "measured" }>, "baseline" | "baselineBefore" | "baselineState">;

function baselineOutcome(enabledAt: Date | undefined, read: PromiseSettledResult<Baseline> | undefined): MeasuredBaseline {
  if (enabledAt === undefined || read === undefined) return { baseline: null, baselineBefore: null, baselineState: "no_policy" };
  const baselineBefore = enabledAt.toISOString();
  if (read.status === "rejected") return { baseline: null, baselineBefore, baselineState: "source_failed" };
  return { baseline: read.value.medians, baselineBefore, baselineState: "measured" };
}

/**
 * A closed pull request's outcome holds for a day, an open one's for 15 minutes; a baseline for the UTC day it was read.
 * Medians stand on the reads that succeeded; the outcomes are unavailable only when every read failed.
 */
export function createOutcomeReader(deps: OutcomeReaderDeps): OutcomeReader {
  const limited = limiter(HOST_READS);
  const prOutcomes = boundedCache<Outcome>();
  const baselines = boundedCache<Baseline>();

  async function outcome(host: Host, pr: PrTimes): Promise<Outcome> {
    const events = await limited(function readTimeline() {
      return host.timeline(pr.number);
    });
    return outcomeOf(pr, events, { author: pr.author, botLogins: host.botLogins });
  }

  async function triagedOutcome(host: Host, key: string, number: number, now: number): Promise<Outcome> {
    return prOutcomes(key, now, async function load() {
      const pr = await limited(function readPr() {
        return host.prTimes(number);
      });
      return outcome(host, pr);
    }, function prTtl(read) {
      return read.closed ? DAY_MS : OPEN_MS;
    });
  }

  async function baselineOf(host: Host, key: string, before: Date, now: number): Promise<Baseline> {
    return baselines(key, now, async function load() {
      const closed = await limited(function readClosed() {
        return host.closedBefore(before);
      });
      if (closed.length === 0) return { medians: null, failed: 0 };
      const { outcomes, failed } = await settledOutcomes(closed.map((pr) => outcome(host, pr)));
      if (outcomes.length === 0) throw new Error(`all ${failed} baseline reads failed`);
      return { medians: medians(outcomes), failed };
    });
  }

  async function read(tenantId: string, principalId: string, repo: string, triaged: readonly number[]): Promise<TriageOutcomes | null> {
    const source = await deps.host(tenantId, principalId, repo);
    if (source === undefined) return null;
    if ("state" in source) return source;
    const { host } = source;
    const now = deps.now();
    const at = now.getTime();
    const enabledAt = await deps.enabledAt(tenantId, repo);
    const [{ outcomes, failed }, [baselineRead]] = await Promise.all([
      settledOutcomes(triaged.map((number) => triagedOutcome(host, `${tenantId}\n${repo}\n${number}`, number, at))),
      Promise.allSettled(enabledAt === undefined ? [] : [baselineOf(host, `${tenantId}\n${repo}\n${utcDay(now)}\n${enabledAt.toISOString()}`, enabledAt, at)]),
    ]);
    const baseline = baselineRead?.status === "fulfilled" ? baselineRead.value : undefined;
    const baselineFailed = baselineRead?.status === "rejected";
    const failedReads = failed + (baselineFailed ? 1 : (baseline?.failed ?? 0));
    if (failedReads > 0) deps.log({ level: "warn", msg: "triage_outcomes_failed", tenantId, repo, failed: failedReads });
    if (failed > 0 && outcomes.length === 0 && (enabledAt === undefined || baselineFailed)) return { state: "source_failed" };
    return { state: "measured", triaged: medians(outcomes), ...baselineOutcome(enabledAt, baselineRead) };
  }

  async function refusal({ tenantId, principalId }: Member, repo: string): Promise<Refusal> {
    const source = await deps.host(tenantId, principalId, repo);
    if (source === undefined) return null;
    if ("state" in source) return source;
    return undefined;
  }

  async function outcomes({ tenantId, principalId }: Member, repo: string, triaged: readonly number[]): Promise<TriageOutcomes | null> {
    try {
      return await read(tenantId, principalId, repo, triaged);
    } catch (error) {
      deps.log({ level: "warn", msg: "triage_outcomes_failed", tenantId, repo, error: errorText(error) });
      return { state: "source_failed" };
    }
  }

  return { refusal, read: outcomes };
}

type HostReadsDeps = SourceFetchDeps & { artifacts: ArtifactDb };

/** The repository's host read as the tenant's GitHub App or Bitbucket Data Center token, as the PR view reads it. */
export function createHostReads(deps: HostReadsDeps): Pick<OutcomeReaderDeps, "host" | "enabledAt"> {
  const sourceFetch = createSourceFetch(deps);

  async function host(tenantId: string, principalId: string, repo: string): Promise<HostRead> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    const ns = triageNs(tenant?.config);
    const record = repoRecords(ns).find((row) => row.name === repo && row.connected);
    if (!record) return undefined;
    if (await sourceCredentialGrant(deps, principalId, tenantId, record, "read")) return { state: "no_credential" };
    const source = await sourceFetch(tenantId, principalId, record);
    if (!source) return { state: "no_credential" };
    if ("bb" in source) {
      const { bb } = source;
      const own = bitbucketConnection(ns)?.user;
      return {
        host: {
          prTimes: (number) => bitbucket.getPrTimes(bb, repo, number),
          timeline: (number) => bitbucket.listPrTimeline(bb, repo, number),
          closedBefore: (before) => bitbucket.listClosedPrsBefore(bb, repo, before),
          // The token user posts triage's own comments and reviews, and Data Center marks only access-token users as bots.
          botLogins: own === undefined ? [] : [own],
        },
      };
    }
    const { gh } = source;
    return {
      host: {
        prTimes: (number) => getPrTimes(gh, repo, number),
        timeline: (number) => listPrTimeline(gh, repo, number),
        closedBefore: (before) => searchClosedPrsBefore(gh, repo, before),
        botLogins: [],
      },
    };
  }

  async function enabledAt(tenantId: string, repo: string): Promise<Date | undefined> {
    return (await repoPolicyRow(deps, tenantId, repo))?.createdAt;
  }

  return { host, enabledAt };
}
