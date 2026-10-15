// The latest verdict of each open pull request, with the pr-triage run in
// flight for it, so the portal lists pull requests without reading run logs.
// Reads only: the tables, the tenant observer's last read of the live logs and
// the open pull requests GitHub last listed. The body is kept per workspace
// until any of those changes, so polling tabs are answered from memory. It
// needs the grant the portal needed to read run logs, `workflow-run:*` read.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { PR_TRIAGE_STUCK_RUN_MS, repoPolicy, TriageVerdicts, type VerdictWord } from "@corbits/triage-contracts";
import { listConnectedPulls, listingRefusal, refusedSources, type OpenPrsLister, type OpenPullsCache, type OpenPullsRead, type RepoPulls } from "./open-pulls.js";
import { failure, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { runKeyNumber, type ObservedRun } from "./reconcile-plan.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";
import type { TenantObservation, TenantObserver, TenantVersions } from "./tenant-observer.js";
import { type PullRef, type VerdictRecord, type VerdictRecordStore } from "./verdict-record-store.js";

export const TRIAGE_VERDICTS_PATH = "/api/integrations/triage-verdicts";

/**
 * Webhook events, as `event:action`, that mean someone other than the App moved the pull request: a push, reopen, ready for review,
 * review request, comment or review. CI results, catch-up runs, labels, assignment and edits do not; the App's own writes start no run.
 */
const AUTHOR_ACTIVITY = [
  "pull_request:synchronize",
  "pull_request:reopened",
  "pull_request:ready_for_review",
  "pull_request:review_requested",
  "issue_comment:created",
  "pull_request_review:submitted",
];

/**
 * Where GitHub could not say which pull requests are open, only those with a verdict this recent are listed, rather than every
 * pull request ever triaged; a repository counts as triaged with a verdict this recent.
 */
const RECENT_MS = 14 * 24 * 60 * 60_000;
/** A kept body is rebuilt at least this often, so a run turns stuck without anything else changing. */
const REBUILD_MS = 60_000;
/** GitHub's listing of open pull requests is reused this long; the portal's own listing refreshes it more often while it is open. */
const LISTING_MS = 30_000;

const PullQuery = type({
  "repo?": /^[\w.-]+\/[\w.-]+$/,
  "number?": type("string.integer.parse").to("1 <= number.integer <= 2147483647"),
});

type Pull = TriageVerdicts["pulls"][number];
type Run = NonNullable<Pull["run"]>;

export type TriageVerdictsDeps = PortalCredentialDeps & {
  verdicts: Pick<VerdictRecordStore, "latest" | "latestSince" | "latestFor" | "triggeredAt" | "reposSince" | "anyScored">;
  observer: Pick<TenantObserver, "last">;
  ready: (tenantId: string) => boolean;
  versions: Pick<TenantVersions, "get">;
  openPulls: OpenPullsCache;
  list: OpenPrsLister;
  now: () => Date;
};

type LivePull = PullRef & { runs: ObservedRun[] };

function pullKey(pull: PullRef): string {
  return `${pull.repo}#${pull.number}`;
}

function livePulls(observation: TenantObservation | undefined): Map<string, LivePull> {
  const byPull = new Map<string, LivePull>();
  for (const runs of observation?.observed ?? []) {
    for (const [repo, byHead] of runs.byRepo) {
      for (const [key, list] of byHead) {
        const ref = { repo, number: runKeyNumber(key) };
        const pull = byPull.get(pullKey(ref)) ?? { ...ref, runs: [] };
        pull.runs.push(...list);
        byPull.set(pullKey(ref), pull);
      }
    }
  }
  for (const pull of byPull.values()) pull.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return byPull;
}

function runOf(live: ObservedRun | undefined, now: Date, ready: boolean): Run | null {
  if (!ready) return { status: "unknown" };
  if (!live || live.status === "completed") return null;
  const { runId, startedAt } = live;
  if (live.status === "failed" || live.status === "cancelled") return { runId, startedAt, status: live.status };
  const stuck = now.getTime() - Date.parse(startedAt) > PR_TRIAGE_STUCK_RUN_MS;
  return { runId, startedAt, status: stuck ? "stuck" : "running" };
}

const STATE_VERDICTS: Record<string, VerdictWord> = { "ready-monitoring": "pass", blocked: "fail", "needs-decision": "fail", "needs-author-update": "fail" };

/** A verdict recorded before verdicts were words reads from its state: degraded or anything else is unsure. */
function wordOf({ state, degraded, detail }: VerdictRecord): VerdictWord {
  if (detail?.verdict !== undefined) return detail.verdict;
  return degraded === null ? STATE_VERDICTS[state] ?? "unsure" : "unsure";
}

function verdictOf(latest: VerdictRecord | undefined): Pull["verdict"] {
  if (!latest) return null;
  const { runId, verdictAt, headSha, settled, state, actor, humanGated, degraded, commented, checks, detail } = latest;
  return { runId, at: verdictAt.toISOString(), headSha, verdict: wordOf(latest), settled, state, actor, humanGated, degraded, commented, checks, detail };
}

function newest(times: ReadonlyArray<string | undefined>): string | null {
  return times.reduce<string | null>((latest, at) => (at !== undefined && (latest === null || at > latest) ? at : latest), null);
}

/**
 * Open pull request numbers per listed repository among `repos`, plus the `held` ones elsewhere: an approval still needs a person
 * after triage is turned off. A repository GitHub could not list is left out.
 */
function openNumbers(listed: OpenPullsRead | undefined, repos: readonly string[], held: readonly PullRef[]): Map<string, Set<number>> {
  if (!listed) return new Map();
  function numbersOf(row: RepoPulls): Array<readonly [string, Set<number>]> {
    if (row.error !== undefined) return [];
    const wanted = repos.includes(row.repo);
    const numbers = row.prs.map((pr) => pr.number).filter((number) => wanted || held.some((pull) => pull.repo === row.repo && pull.number === number));
    return wanted || numbers.length > 0 ? [[row.repo, new Set(numbers)]] : [];
  }
  return new Map(listed.repos.flatMap(numbersOf));
}

const ApprovalPull = type({ repo: "string", number: "number.integer" });

type Body = { json: string; etag: string };

function bodyOf(verdicts: TriageVerdicts): Body {
  const json = JSON.stringify(verdicts);
  return { json, etag: `"${createHash("sha1").update(json).digest("base64url")}"` };
}

function respond(req: Request, body: Body): Response {
  const headers = { etag: body.etag, "cache-control": "private, no-cache" };
  if (req.headers.get("if-none-match") === body.etag) return new Response(null, { status: 304, headers });
  return new Response(body.json, { headers: { ...headers, "content-type": "application/json" } });
}

export function createTriageVerdicts(deps: TriageVerdictsDeps) {
  const kept = new Map<string, { key: string; body: Body }>();

  /**
   * The listing kept from the last 30 seconds, else one read now on each repository's host, like github-open-pulls, when
   * the caller holds `read` on every host's credential, a host with none listed as errors. When github-open-pulls would refuse,
   * the route asks nothing and uses the last listing of any age, or none, rather than refusing: the verdicts themselves need only the run grant.
   */
  async function listingOf(member: Member, connected: readonly RepoRecord[]): Promise<OpenPullsRead | undefined> {
    const { tenantId } = member;
    const fresh = deps.openPulls.kept(tenantId, LISTING_MS);
    if (fresh) return fresh;
    const refused = await refusedSources(deps, member, connected);
    if (listingRefusal(connected, refused)) return deps.openPulls.kept(tenantId, Infinity);
    return deps.openPulls.read(tenantId, () => listConnectedPulls(deps.list, tenantId, connected, refused));
  }

  async function activityOf(tenantId: string, pulls: readonly PullRef[], live: Map<string, LivePull>): Promise<Map<string, string>> {
    const recorded = await deps.verdicts.triggeredAt(tenantId, pulls, AUTHOR_ACTIVITY);
    const at = new Map(recorded.map((row) => [pullKey(row), row.at.toISOString()]));
    for (const pull of pulls) {
      const runs = live.get(pullKey(pull))?.runs ?? [];
      const started = newest([at.get(pullKey(pull)), ...runs.map((run) => (run.trigger !== undefined && AUTHOR_ACTIVITY.includes(run.trigger) ? run.startedAt : undefined))]);
      if (started !== null) at.set(pullKey(pull), started);
    }
    return at;
  }

  async function reposOf(tenantId: string, names: readonly string[], live: Map<string, LivePull>, since?: Date): Promise<string[]> {
    const seen = new Set(await deps.verdicts.reposSince(tenantId, names, since));
    for (const pull of live.values()) seen.add(pull.repo);
    return names.filter((repo) => seen.has(repo));
  }

  async function build(tenantId: string, latest: readonly VerdictRecord[], live: Map<string, LivePull>, wanted: (pull: PullRef) => boolean, names: readonly string[]): Promise<TriageVerdicts> {
    const now = deps.now();
    const byPull = new Map(latest.map((verdict) => [pullKey(verdict), verdict]));
    const refs = new Map<string, PullRef>();
    for (const ref of [...latest, ...live.values()]) {
      if (wanted(ref)) refs.set(pullKey(ref), { repo: ref.repo, number: ref.number });
    }
    const pulls = [...refs.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
    const [activity, triaged, active, scored] = await Promise.all([
      activityOf(tenantId, pulls, live),
      reposOf(tenantId, names, live),
      reposOf(tenantId, names, live, new Date(now.getTime() - RECENT_MS)),
      deps.verdicts.anyScored(tenantId),
    ]);
    const ready = deps.ready(tenantId);
    return {
      pulls: pulls.map((ref) => ({
        ...ref,
        activityAt: activity.get(pullKey(ref)) ?? null,
        verdict: verdictOf(byPull.get(pullKey(ref))),
        run: runOf(live.get(pullKey(ref))?.runs[0], now, ready),
      })),
      triaged,
      active,
      scored,
    };
  }

  /** The pull requests a pending approval names. */
  async function heldPulls(tenantId: string): Promise<PullRef[]> {
    const rows = await deps.db.select({ args: schema.approval.toolArguments }).from(schema.approval).where(and(eq(schema.approval.tenantId, tenantId), eq(schema.approval.status, "pending")));
    function pullOf(row: { args: unknown }): PullRef[] {
      const pull = ApprovalPull(row.args);
      return pull instanceof type.errors ? [] : [{ repo: pull.repo, number: pull.number }];
    }
    return rows.flatMap(pullOf);
  }

  /** Lists the pull requests of `enabled` repositories and the `held` ones; `names`, every connected one, still decides which count as triaged. */
  async function openList(tenantId: string, enabled: readonly string[], held: readonly PullRef[], names: readonly string[], listed: OpenPullsRead | undefined, live: Map<string, LivePull>): Promise<TriageVerdicts> {
    const open = openNumbers(listed, enabled, held);
    const unknown = enabled.filter((repo) => !open.has(repo));
    const pairs = [...open].flatMap(([repo, numbers]) => [...numbers].map((number) => ({ repo, number })));
    const since = new Date(deps.now().getTime() - RECENT_MS);
    const [known, recent] = await Promise.all([deps.verdicts.latest(tenantId, pairs), deps.verdicts.latestSince(tenantId, unknown, since)]);
    function wanted(pull: PullRef): boolean {
      const numbers = open.get(pull.repo);
      return numbers === undefined ? unknown.includes(pull.repo) : numbers.has(pull.number);
    }
    return build(tenantId, [...known, ...recent], live, wanted, names);
  }

  return async function handle(req: Request, member: Member): Promise<Response> {
    const { tenantId } = member;
    const query = PullQuery(Object.fromEntries(new URL(req.url).searchParams));
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    if ((query.repo === undefined) !== (query.number === undefined)) return failure(400, "invalid_request", "Name both repo and number, or neither.");
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const connected = repoRecords(triageNs(tenant.config)).filter((record) => record.connected);
    const names = connected.map((record) => record.name);
    const live = livePulls(deps.observer.last(tenantId));

    if (query.repo !== undefined && query.number !== undefined) {
      const pull = { repo: query.repo, number: query.number };
      if (!names.includes(pull.repo)) return failure(404, "not_found", "That repository is not connected.");
      const latest = await deps.verdicts.latestFor(tenantId, pull.repo, pull.number);
      const one = await build(tenantId, latest ? [latest] : [], new Map([...live].filter(([key]) => key === pullKey(pull))), () => true, names);
      return respond(req, bodyOf(one.pulls.length > 0 ? one : { ...one, pulls: [{ ...pull, activityAt: null, verdict: null, run: runOf(undefined, deps.now(), deps.ready(tenantId)) }] }));
    }

    const enabledNames = connected.filter((record) => repoPolicy(record).enabled).map((record) => record.name);
    const [listed, held] = await Promise.all([listingOf(member, connected), heldPulls(tenantId)]);
    const key = [deps.versions.get(tenantId), listed?.at, deps.ready(tenantId), Math.floor(deps.now().getTime() / REBUILD_MS), ...names, "--", ...enabledNames, "--", ...held.map(pullKey).sort()].join("\n");
    const hit = kept.get(tenantId);
    if (hit?.key === key) return respond(req, hit.body);
    const body = bodyOf(await openList(tenantId, enabledNames, held, names, listed, live));
    kept.set(tenantId, { key, body });
    return respond(req, body);
  };
}
