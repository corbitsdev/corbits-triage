// The latest verdict of each open pull request, with the pr-triage run in
// flight for it, so the portal lists pull requests without reading run logs.
// Reads only: the tables, the tenant observer's last read of the live logs and
// the open pull requests GitHub last listed. The body is kept per workspace
// until any of those changes, so polling tabs are answered from memory. It
// needs the grant the portal needed to read run logs, `workflow-run:*` read.
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { PR_TRIAGE_STUCK_RUN_MS } from "@corbits/triage-contracts";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { listRepoPulls, type OpenPullsCache, type OpenPullsRead } from "./open-pulls.js";
import { appGithubFetch, failure, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { runKeyNumber, type ObservedRun } from "./reconcile-plan.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";
import type { TenantObservation, TenantObserver, TenantVersions } from "./tenant-observer.js";
import { VerdictDetail, type PullRef, type VerdictRecord, type VerdictRecordStore } from "./verdict-record-store.js";

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

const Verdict = type({
  runId: "string",
  at: "string",
  headSha: "string",
  settled: "boolean",
  state: "string",
  actor: "string",
  humanGated: "boolean",
  degraded: "string | null",
  commented: "boolean",
  checks: type({ check: "string", result: "string" }).array(),
  /** Null on verdicts recorded before it was, whose run log the hub could not read again. */
  detail: VerdictDetail.or("null"),
});

/**
 * The pull request's latest run, when it has not completed: still going, ended early, or running longer than any run can.
 * `unknown` until the hub read the workspace's live logs since it started, when a run may be going unseen.
 */
const Run = type({
  runId: "string",
  startedAt: "string",
  status: "'running' | 'failed' | 'cancelled' | 'stuck'",
}).or({ status: "'unknown'" });
type Run = typeof Run.infer;

const Pull = type({
  repo: "string",
  number: "number",
  /** When the newest run started by author activity started. */
  activityAt: "string | null",
  verdict: Verdict.or("null"),
  run: Run.or("null"),
});
type Pull = typeof Pull.infer;

export const TriageVerdicts = type({
  pulls: Pull.array(),
  /** Connected repositories with any verdict recorded or a run in a live log. */
  triaged: "string[]",
  /** Connected repositories with a verdict in the last 14 days or a run in a live log. */
  active: "string[]",
  /** Whether the decision model scored any verdict. */
  scored: "boolean",
});
export type TriageVerdicts = typeof TriageVerdicts.infer;

export type TriageVerdictsDeps = PortalCredentialDeps & {
  verdicts: Pick<VerdictRecordStore, "latest" | "latestSince" | "latestFor" | "triggeredAt" | "reposSince" | "anyScored">;
  observer: Pick<TenantObserver, "last">;
  /** Whether the hub read the tenant's live logs since it started. */
  ready: (tenantId: string) => boolean;
  versions: Pick<TenantVersions, "get">;
  openPulls: OpenPullsCache;
  githubApiOrigin: string;
  now: () => Date;
};

/** A pull request's runs in the live logs, newest first. */
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

function verdictOf(latest: VerdictRecord | undefined): Pull["verdict"] {
  if (!latest) return null;
  const { runId, verdictAt, headSha, settled, state, actor, humanGated, degraded, commented, checks, detail } = latest;
  return { runId, at: verdictAt.toISOString(), headSha, settled, state, actor, humanGated, degraded, commented, checks, detail };
}

function newest(times: ReadonlyArray<string | undefined>): string | null {
  return times.reduce<string | null>((latest, at) => (at !== undefined && (latest === null || at > latest) ? at : latest), null);
}

/** Open pull request numbers per repository GitHub listed; a repository it could not list is left out. */
function openNumbers(listed: OpenPullsRead | undefined): Map<string, Set<number>> {
  if (!listed) return new Map();
  return new Map(listed.repos.flatMap((row) => (row.error === undefined ? [[row.repo, new Set(row.prs.map((pr) => pr.number))] as const] : [])));
}

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
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  /**
   * The listing kept from the last 30 seconds, else one read now as the App, like github-open-pulls, when the caller holds `read`
   * on the GitHub credential. Without it the route asks GitHub nothing and uses the last listing of any age, or none, rather
   * than refusing: the verdicts themselves need only the run grant.
   */
  async function listingOf(principalId: string, tenantId: string, connected: readonly RepoRecord[]): Promise<OpenPullsRead | undefined> {
    const fresh = deps.openPulls.kept(tenantId, LISTING_MS);
    if (fresh) return fresh;
    const appJson = await githubAppCredential(deps, principalId, tenantId, "read");
    if (appJson instanceof Response) return deps.openPulls.kept(tenantId, Infinity);
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
    return deps.openPulls.read(tenantId, () => listRepoPulls(gh, connected));
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

  async function openList(tenantId: string, connected: readonly RepoRecord[], listed: OpenPullsRead | undefined, live: Map<string, LivePull>): Promise<TriageVerdicts> {
    const names = connected.map((record) => record.name);
    const open = openNumbers(listed);
    const unknown = names.filter((repo) => !open.has(repo));
    const pairs = [...open].flatMap(([repo, numbers]) => [...numbers].map((number) => ({ repo, number })));
    const since = new Date(deps.now().getTime() - RECENT_MS);
    const [known, recent] = await Promise.all([deps.verdicts.latest(tenantId, pairs), deps.verdicts.latestSince(tenantId, unknown, since)]);
    function wanted(pull: PullRef): boolean {
      const numbers = open.get(pull.repo);
      return numbers === undefined ? unknown.includes(pull.repo) : numbers.has(pull.number);
    }
    return build(tenantId, [...known, ...recent], live, wanted, names);
  }

  return async function handle(req: Request, { tenantId, principalId }: Member): Promise<Response> {
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

    const listed = await listingOf(principalId, tenantId, connected);
    const key = [deps.versions.get(tenantId), listed?.at, deps.ready(tenantId), Math.floor(deps.now().getTime() / REBUILD_MS), ...names].join("\n");
    const hit = kept.get(tenantId);
    if (hit?.key === key) return respond(req, hit.body);
    const body = bodyOf(await openList(tenantId, connected, listed, live));
    kept.set(tenantId, { key, body });
    return respond(req, body);
  };
}
