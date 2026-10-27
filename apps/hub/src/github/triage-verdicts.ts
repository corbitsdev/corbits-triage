// The latest verdict of each open pull request, with its manager's run in flight,
// so the portal lists pull requests without reading run logs. Reads only: the
// tables, the managers' claims, the triage state of heads waiting for CI and the
// open pull requests GitHub last listed. The body is kept per workspace until any
// of those changes, so polling tabs are answered from memory. It needs the grant
// the portal needed to read run logs, `workflow-run:*` read.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { schema } from "@intx/db";
import { PR_TRIAGE_STUCK_RUN_MS, REPO_SOURCES, repoPolicy, triageStopped, TriageVerdicts, type PrTriageRow, type RepoSource, type VerdictWord } from "@corbits/triage-contracts";
import { bitbucketWrite } from "@corbits/bitbucket-datacenter-tool";
import { listConnectedPulls, listingRefusal, refusedSources, type OpenPrsLister, type OpenPullsCache, type OpenPullsRead, type RepoPulls } from "./open-pulls.js";
import { failure, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { runKeyNumber, type ObservedRun } from "./reconcile-plan.js";
import { repoRecords, sourceOf, triageNs, triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { TriageStateStore } from "./triage-state-store.js";
import type { ManagerRuns, ObservedRuns } from "./manager-runs.js";
import { type HostedPull, type HostedRepo, type HostedVerdict, type VerdictRecord, type VerdictRecordStore } from "./verdict-record-store.js";

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
  "source?": type.enumerated(...REPO_SOURCES),
});

type Pull = TriageVerdicts["pulls"][number];
type Run = NonNullable<Pull["run"]>;

export type TriageVerdictsDeps = PortalCredentialDeps & {
  verdicts: Pick<VerdictRecordStore, "latest" | "latestSince" | "latestFor" | "triggeredAt" | "reposSince" | "anyScored">;
  managerRuns: ManagerRuns;
  openPulls: OpenPullsCache;
  list: OpenPrsLister;
  triageState: Pick<TriageStateStore, "load">;
  now: () => Date;
};

type LivePull = HostedPull & { runs: ObservedRun[] };

/** A pull request whose newest head waits for CI, first seen `since`. */
type WaitingPull = HostedPull & { since: string; headSha: string };

/** Why the pull request's current head has no verdict, in words for the portal, with the pull request and head it belongs to. */
type Untriaged = HostedPull & { untriaged: string; headSha: string };

type PullNotes = { waiting: Map<string, WaitingPull>; untriaged: Map<string, Untriaged> };

/** Each listed repository on its host, with the head sha of each open pull request. */
type OpenHeads = Map<string, HostedRepo & { heads: Map<number, string> }>;

/** What a person sees for a head's stored note. The stopped-triage note is already written for them; any other note stays internal. */
const UNTRIAGED_TEXT: ReadonlyMap<string, string> = new Map([
  ["run never started", "Couldn't triage: the run never started"],
  ["run lost", "Couldn't triage: the run was lost"],
  ["run stuck", "Couldn't triage: the run stopped responding"],
  ["run failed", "Couldn't triage: the run failed"],
  ["run cancelled", "Couldn't triage: the run was cancelled"],
]);

function untriagedText(error: string, source: RepoSource): string | undefined {
  return error === triageStopped(source) ? error : UNTRIAGED_TEXT.get(error);
}

function hostKey({ repo, source }: HostedRepo): string {
  return triageStateKey({ name: repo, source });
}

function pullKey(pull: HostedPull): string {
  return `${hostKey(pull)}#${pull.number}`;
}

function livePulls(runs: ObservedRuns): Map<string, LivePull> {
  const byPull = new Map<string, LivePull>();
  for (const [repo, byHead] of runs.byRepo) {
    for (const [key, list] of byHead) {
      for (const run of list) {
        const ref = { repo, source: run.source, number: runKeyNumber(key) };
        const pull = byPull.get(pullKey(ref)) ?? { ...ref, runs: [] };
        pull.runs.push(run);
        byPull.set(pullKey(ref), pull);
      }
    }
  }
  for (const pull of byPull.values()) pull.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return byPull;
}

/** A manager up between passes, as while it waits on a reviewer, runs nothing; a running one counts from the pass it took. */
function runOf(live: ObservedRun | undefined, now: Date): Run | null {
  if (!live || live.status === "completed") return null;
  const { runId } = live;
  if (live.status === "failed" || live.status === "cancelled") return { runId, startedAt: live.startedAt, status: live.status };
  if (live.passAt === undefined) return null;
  const startedAt = live.passAt;
  const stuck = now.getTime() - Date.parse(startedAt) > PR_TRIAGE_STUCK_RUN_MS;
  return { runId, startedAt, status: stuck ? "stuck" : "running" };
}

/** Waiting for CI holds the head's run back, so an earlier head's run says nothing about it. */
function runFor(waiting: WaitingPull | undefined, live: ObservedRun | undefined, now: Date): Run | null {
  return waiting === undefined ? runOf(live, now) : { status: "waiting-ci", since: waiting.since, headSha: waiting.headSha };
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

/** The connected `repo` on `source`; without one, as a repository link resolves: the GitHub one, else the only one. */
function connectedRecord(connected: readonly RepoRecord[], repo: string, source: RepoSource | undefined): RepoRecord | undefined {
  const named = connected.filter((record) => record.name === repo);
  if (source !== undefined) return named.find((record) => sourceOf(record) === source);
  return named.find((record) => sourceOf(record) === "github") ?? (named.length === 1 ? named[0] : undefined);
}

/**
 * Open pull requests per listed repository on its host among `records`, plus the `held` ones elsewhere: an approval
 * still needs a person after triage is turned off. A repository its host could not list is left out.
 */
function openHeads(listed: OpenPullsRead | undefined, records: readonly RepoRecord[], held: readonly HostedPull[]): OpenHeads {
  if (!listed) return new Map();
  function headsOf({ repo, source, prs, error }: RepoPulls): Array<readonly [string, HostedRepo & { heads: Map<number, string> }]> {
    if (error !== undefined) return [];
    const key = hostKey({ repo, source });
    const wanted = records.some((record) => triageStateKey(record) === key);
    const heads = prs.filter((pr) => wanted || held.some((pull) => pullKey(pull) === pullKey({ repo, source, number: pr.number }))).map((pr) => [pr.number, pr.sha] as const);
    return wanted || heads.length > 0 ? [[key, { repo, source, heads: new Map(heads) }]] : [];
  }
  return new Map(listed.repos.flatMap(headsOf));
}

/**
 * A note explains the head it was recorded on while that head is still open, or while the host can't say: it could not list the
 * repository, or listed the pull request open with no head.
 */
function noteCurrent(open: OpenHeads, pull: HostedPull, headSha: string): boolean {
  const listing = open.get(hostKey(pull));
  if (listing === undefined) return true;
  const head = listing.heads.get(pull.number);
  return head !== undefined && (head === "" || head === headSha);
}

const ApprovalPull = type({ repo: "string", number: "number.integer" });

/** A held approval's host is its tool's: Bitbucket Data Center's write tools, else GitHub's. */
const BITBUCKET_WRITE_TOOLS: ReadonlySet<unknown> = new Set(bitbucketWrite.definitions.map((definition) => definition.name));

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
   * The open pull requests of `records`, kept under `key`: a listing from the last 30 seconds under `key`, or the workspace's
   * shared one, else one read now on each repository's host, like github-open-pulls, when the caller holds `read` on every host's
   * credential, a host with none listed as errors. When github-open-pulls would refuse, the route asks nothing and uses the last
   * listing of any age, or none, rather than refusing: the verdicts themselves need only the run grant.
   */
  async function listingOf(member: Member, key: string, records: readonly RepoRecord[]): Promise<OpenPullsRead | undefined> {
    const { tenantId } = member;
    const fresh = deps.openPulls.kept(key, LISTING_MS) ?? deps.openPulls.kept(tenantId, LISTING_MS);
    if (fresh) return fresh;
    const refused = await refusedSources(deps, member, records);
    if (listingRefusal(records, refused)) return deps.openPulls.kept(key, Infinity) ?? deps.openPulls.kept(tenantId, Infinity);
    return deps.openPulls.read(key, () => listConnectedPulls(deps.list, tenantId, records, refused));
  }

  async function activityOf(tenantId: string, pulls: readonly HostedPull[], live: Map<string, LivePull>): Promise<Map<string, string>> {
    const recorded = await deps.verdicts.triggeredAt(tenantId, pulls, AUTHOR_ACTIVITY);
    const at = new Map(recorded.map((row) => [pullKey(row), row.at.toISOString()]));
    for (const pull of pulls) {
      const runs = live.get(pullKey(pull))?.runs ?? [];
      const started = newest([at.get(pullKey(pull)), ...runs.map((run) => (run.trigger !== undefined && AUTHOR_ACTIVITY.includes(run.trigger) ? run.startedAt : undefined))]);
      if (started !== null) at.set(pullKey(pull), started);
    }
    return at;
  }

  /** The connected repositories, each on its host, with a verdict since `since`, or ever, or a manager's run. */
  async function reposOf(tenantId: string, connected: readonly RepoRecord[], live: Map<string, LivePull>, since?: Date): Promise<HostedRepo[]> {
    const seen = new Set((await deps.verdicts.reposSince(tenantId, connected.map((record) => record.name), since)).map(hostKey));
    for (const pull of live.values()) seen.add(hostKey(pull));
    return connected.map((record) => ({ repo: record.name, source: sourceOf(record) })).filter((repo) => seen.has(hostKey(repo)));
  }

  /** The newest stored head of each pull request: one waiting for CI, and why triage produced no verdict when a person can read it and the head is `current`. */
  async function notesOf(tenantId: string, records: readonly RepoRecord[], current: (pull: HostedPull, headSha: string) => boolean): Promise<PullNotes> {
    const states = await Promise.all(records.map((record) => deps.triageState.load(tenantId, triageStateKey(record))));
    const waiting = new Map<string, WaitingPull>();
    const untriaged = new Map<string, Untriaged>();
    for (const [index, { rows }] of states.entries()) {
      const newest = new Map<number, PrTriageRow>();
      for (const row of [...rows].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))) newest.set(row.number, row);
      for (const row of newest.values()) {
        const pull = { repo: records[index]!.name, source: sourceOf(records[index]!), number: row.number };
        if (row.status === "waiting") waiting.set(pullKey(pull), { ...pull, since: row.firstSeenAt, headSha: row.headSha });
        const text = row.error === undefined ? undefined : untriagedText(row.error, pull.source);
        if (text !== undefined && current(pull, row.headSha)) untriaged.set(pullKey(pull), { ...pull, untriaged: text, headSha: row.headSha });
      }
    }
    return { waiting, untriaged };
  }

  /** `noted`: the pull requests a note alone lists, being known open. */
  async function build(tenantId: string, latest: readonly HostedVerdict[], live: Map<string, LivePull>, notes: PullNotes, noted: readonly HostedPull[], wanted: (pull: HostedPull) => boolean, connected: readonly RepoRecord[]): Promise<TriageVerdicts> {
    const now = deps.now();
    const byPull = new Map(latest.map((verdict) => [pullKey(verdict), verdict]));
    const refs = new Map<string, HostedPull>();
    for (const ref of [...latest, ...live.values(), ...notes.waiting.values(), ...noted]) {
      if (wanted(ref)) refs.set(pullKey(ref), { repo: ref.repo, number: ref.number, source: ref.source });
    }
    const pulls = [...refs.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number || a.source.localeCompare(b.source));
    const [activity, triaged, active, scored] = await Promise.all([
      activityOf(tenantId, pulls, live),
      reposOf(tenantId, connected, live),
      reposOf(tenantId, connected, live, new Date(now.getTime() - RECENT_MS)),
      deps.verdicts.anyScored(tenantId),
    ]);
    return {
      pulls: pulls.map((ref) => {
        const verdict = verdictOf(byPull.get(pullKey(ref)));
        // A verdict replaces the note: it only explains a pull request that still has none.
        const untriaged = verdict === null ? notes.untriaged.get(pullKey(ref))?.untriaged : undefined;
        return {
          ...ref,
          activityAt: activity.get(pullKey(ref)) ?? null,
          verdict,
          run: runFor(notes.waiting.get(pullKey(ref)), live.get(pullKey(ref))?.runs[0], now),
          ...(untriaged !== undefined && { untriaged }),
        };
      }),
      triaged,
      active,
      scored,
    };
  }

  /** The pull requests a pending approval names. */
  async function heldPulls(tenantId: string): Promise<HostedPull[]> {
    const rows = await deps.db.select({ args: schema.approval.toolArguments, tool: schema.approval.toolDefinition }).from(schema.approval).where(and(eq(schema.approval.tenantId, tenantId), eq(schema.approval.status, "pending")));
    function pullOf(row: { args: unknown; tool: unknown }): HostedPull[] {
      const pull = ApprovalPull(row.args);
      const source = BITBUCKET_WRITE_TOOLS.has(asRecord(row.tool)?.["name"]) ? "bitbucket-datacenter" : "github";
      return pull instanceof type.errors ? [] : [{ repo: pull.repo, number: pull.number, source }];
    }
    return rows.flatMap(pullOf);
  }

  /** Lists the pull requests of `enabled` repositories and the `held` ones; `connected`, every connected one, still decides which count as triaged. */
  async function openList(tenantId: string, enabled: readonly RepoRecord[], connected: readonly RepoRecord[], open: OpenHeads, live: Map<string, LivePull>): Promise<TriageVerdicts> {
    const unknown = enabled.filter((record) => !open.has(triageStateKey(record)));
    const unlisted = new Set(unknown.map(triageStateKey));
    const pairs = [...open.values()].flatMap(({ repo, heads }) => [...heads.keys()].map((number) => ({ repo, number })));
    const since = new Date(deps.now().getTime() - RECENT_MS);
    // A repository its host could not list keeps its notes, shown only on a pull request listed for another reason.
    const [known, recent, notes] = await Promise.all([
      deps.verdicts.latest(tenantId, pairs),
      deps.verdicts.latestSince(tenantId, unknown.map((record) => record.name), since),
      notesOf(tenantId, enabled, (pull, headSha) => noteCurrent(open, pull, headSha)),
    ]);
    function wanted(pull: HostedPull): boolean {
      const listing = open.get(hostKey(pull));
      return listing === undefined ? unlisted.has(hostKey(pull)) : listing.heads.has(pull.number);
    }
    const noted = [...notes.untriaged.values()].filter((pull) => open.has(hostKey(pull)));
    return build(tenantId, [...known.filter((verdict) => open.has(hostKey(verdict))), ...recent], live, notes, noted, wanted, connected);
  }

  return async function handle(req: Request, member: Member): Promise<Response> {
    const { tenantId } = member;
    const query = PullQuery(Object.fromEntries(new URL(req.url).searchParams));
    if (query instanceof type.errors) return failure(400, "invalid_request", query.summary);
    if ((query.repo === undefined) !== (query.number === undefined)) return failure(400, "invalid_request", "Name both repo and number, or neither.");
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const connected = repoRecords(triageNs(tenant.config)).filter((record) => record.connected);

    if (query.repo !== undefined && query.number !== undefined) {
      const record = connectedRecord(connected, query.repo, query.source);
      if (!record) return failure(404, "not_found", "That repository is not connected.");
      const pull = { repo: query.repo, number: query.number, source: sourceOf(record) };
      const [latest, notes, runs] = await Promise.all([deps.verdicts.latestFor(tenantId, pull), notesOf(tenantId, [record], () => true), deps.managerRuns(tenantId, [pull])]);
      const key = pullKey(pull);
      const note = notes.untriaged.get(key);
      const current = note !== undefined && !latest && noteCurrent(openHeads(await listingOf(member, `${tenantId}\n${triageStateKey(record)}`, [record]), [record], []), note, note.headSha);
      const untriaged = new Map(current ? [[key, note]] : []);
      const one = await build(tenantId, latest ? [latest] : [], new Map([...livePulls(runs)].filter(([id]) => id === key)), {
        waiting: new Map([...notes.waiting].filter(([id]) => id === key)),
        untriaged,
      }, [...untriaged.values()], () => true, connected);
      return respond(req, bodyOf(one.pulls.length > 0 ? one : { ...one, pulls: [{ ...pull, activityAt: null, verdict: null, run: null }] }));
    }

    const enabled = connected.filter((record) => repoPolicy(record).enabled);
    const [listed, held] = await Promise.all([listingOf(member, tenantId, connected), heldPulls(tenantId)]);
    const open = openHeads(listed, enabled, held);
    const pulls = [...open.values()].flatMap(({ repo, source, heads }) => [...heads.keys()].map((number) => ({ repo, source, number })));
    const live = livePulls(await deps.managerRuns(tenantId, pulls));
    const runs = [...live.values()].map((pull) => `${pullKey(pull)}:${pull.runs.map((run) => `${run.runId}:${run.status}`).join(",")}`).sort();
    const key = [listed?.at, Math.floor(deps.now().getTime() / REBUILD_MS), ...connected.map(triageStateKey), "--", ...enabled.map(triageStateKey), "--", ...held.map(pullKey).sort(), "--", ...runs].join("\n");
    const hit = kept.get(tenantId);
    if (hit?.key === key) return respond(req, hit.body);
    const body = bodyOf(await openList(tenantId, enabled, connected, open, live));
    kept.set(tenantId, { key, body });
    return respond(req, body);
  };
}
