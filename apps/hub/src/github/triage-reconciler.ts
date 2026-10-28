// Brings every open pull request on an enabled repository to a triaged head
// without relying on any webhook, sidecar or portal visit having survived:
// reads GitHub's open pull requests, the managers' runs and the stored state,
// then mails what the plan says to the host's listener. A workspace without a
// live listener is left alone. A settled head whose verdict waited on CI is
// queued again here once its CI finished, on hosts and pull requests whose CI
// results send no webhook.
import { hasEnabledRules, repoPolicy, type PrTriageRow, type RepoPolicy, type RepoSource, type VerdictDetail } from "@corbits/triage-contracts";
import { mailPayload, unreadablePayload, type PolicyUnreadable } from "./bridge.js";
import type { TriageJob } from "./triage-queue.js";
import { GithubRateLimited } from "./github-usage.js";
import { failDelivery } from "./triage-queue.js";
import type { PolicyReader, ResolvedPack } from "./repo-policy.js";
import { inFlight, planTenant, requeue, runKey, type OpenPr, type QueuedPr, type ReconcilePolicy, type RepoPlan } from "./reconcile-plan.js";
import { summarizeChecks } from "@corbits/github-reads";
import { repoRecords, sourceOf, triageNs, triageStateKey, type RepoRecord } from "./tenant-config.js";
import type { HeadChecksReader, OpenHeadsReader } from "./tenant-open-heads.js";
import type { RepoActivity } from "./repo-activity.js";
import type { LiveDeployment } from "./deployment.js";
import type { ManagerRuns } from "./manager-runs.js";
import type { VerdictRecord, VerdictRecordStore } from "./verdict-record-store.js";
import { TriageStateConflictError, type LoadedTriageState, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

export type ReconcileTenant = { id: string; domain: string; config: unknown };

export type TriageReconcilerDeps = {
  /** The host whose repositories this reconciler brings to a triaged head. */
  source: RepoSource;
  tenants: () => Promise<ReconcileTenant[]>;
  /** The host's live listener, whose managers run its pull requests; a listener names no workflow version, so no head starts over for one. */
  listener: (tenantId: string, source: RepoSource) => Promise<LiveDeployment | undefined>;
  /** Undefined when the tenant holds no credential for any pull request host. */
  openHeadsFor: (tenantId: string) => Promise<OpenHeadsReader | undefined>;
  /** A repository's open pull requests are listed again only once its last listing may be stale. */
  activity: Pick<RepoActivity, "stale">;
  /**
   * Reads the CI of settled heads whose verdict waits on CI: those are read again on the unconfirmed retry interval,
   * with backoff, and queued once CI changed, for a host that sends no webhook when a build finishes and for a
   * completed check run whose event was lost or not delivered.
   */
  headChecks: HeadChecksReader;
  /** Recorded verdicts, whose CI a settled head is polled for. */
  verdicts: Pick<VerdictRecordStore, "latest">;
  /** The host's pull request managers, read from their claims and the verdicts they reported. */
  managerRuns: ManagerRuns;
  store: TriageStateStore;
  readCheckPack: PolicyReader;
  send: (job: TriageJob) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

type EnabledRepo = { record: RepoRecord; policy: RepoPolicy };
type TenantPass = { tenantId: string; openHeads: OpenHeadsReader };
type LoadedRepo = EnabledRepo & (ResolvedPack | PolicyUnreadable) & { prs: OpenPr[]; stored: LoadedTriageState };

/**
 * `retry` asks for another pass soon: a repository's or a tenant's pass failed.
 * `retryAt` is when a GitHub rate limit the pass ran into lifts; no sooner pass could read anything.
 */
export type ReconcileOutcome = { retry: boolean; retryAt?: number };

function enabledRepos(config: unknown, source: RepoSource): EnabledRepo[] {
  return repoRecords(triageNs(config)).flatMap(function enabled(record) {
    const policy = repoPolicy(record);
    return sourceOf(record) === source && record.connected && policy.enabled ? [{ record, policy }] : [];
  });
}

type Claimed = { rows: PrTriageRow[]; version: TriageStateVersion; enqueue: QueuedPr[] };

function headKey(row: Pick<PrTriageRow, "number" | "headSha">): string {
  return runKey(row.number, row.headSha);
}

/** Theirs in their order, each head replaced by ours only when ours is newer; heads only we have follow. */
function mergeRows(theirs: readonly PrTriageRow[], ours: readonly PrTriageRow[]): PrTriageRow[] {
  const byHead = new Map(ours.map((row) => [headKey(row), row]));
  const merged = theirs.map(function newer(row) {
    const mine = byHead.get(headKey(row));
    byHead.delete(headKey(row));
    return mine !== undefined && new Date(mine.updatedAt).getTime() > new Date(row.updatedAt).getTime() ? mine : row;
  });
  return [...merged, ...byHead.values()];
}

const BUILD_STATUS_CHANGED = "build_status_changed";

type BuildPoll = { polls: number; at: number };

/** A verdict CI decided, or is still to decide: both change when the builds do, so both are polled. */
function waitsOnCi(verdict: { checks: ReadonlyArray<{ check: string; result: string }> }): boolean {
  return verdict.checks.some((check) => check.check === "ci-green" && (check.result === "unconfirmed" || check.result === "fail"));
}

/** The verdict read its CI as cancelled, which stays so until a check is re-run; one without its rule's detail is taken as cancelled, so it is not run again and again. */
function readCancelled(verdict: { detail?: VerdictDetail | null }): boolean {
  const ciGreen = verdict.detail?.checks?.find((check) => check.check === "ci-green");
  if (ciGreen === undefined) return true;
  const values = ciGreen.output?.["values"];
  return typeof values === "object" && values !== null && "status" in values && values.status === "cancelled";
}

export function createTriageReconciler(deps: TriageReconcilerDeps) {
  /** Heads whose builds were read since their verdict; lost on restart, when the verdict's own time starts the interval again. */
  const buildPolls = new Map<string, BuildPoll>();
  /** Repositories skipped last pass and why, so the skip is logged once rather than every pass. */
  const skippedRepos = new Map<string, string>();
  /** The latest reset among the GitHub rate limits this pass ran into. */
  let limitedUntil: number | undefined;
  /** The limit last logged, so one limit is logged once rather than per repository per pass. */
  let loggedLimit: number | undefined;

  /** False for a GitHub rate limit, which is noted for the pass's outcome rather than logged and retried. */
  function reconcileFailed(entry: Record<string, unknown>, err: unknown): boolean {
    if (err instanceof GithubRateLimited) {
      limitedUntil = Math.max(limitedUntil ?? 0, err.resetAt);
      return false;
    }
    deps.log({ level: "error", msg: "triage_reconcile_failed", ...entry, error: String(err) });
    return true;
  }

  /**
   * Each tenant's last listing of each repository's open pull requests, with when it started. A failed read or a tenant
   * without a reader drops it, so a credential failure shows on the next pass; lost on restart, when every repository is listed again.
   */
  const listings = new Map<string, Map<string, { at: number; prs: OpenPr[] }>>();

  async function openPrs(pass: TenantPass, record: RepoRecord): Promise<OpenPr[]> {
    const listed = listings.get(pass.tenantId) ?? new Map<string, { at: number; prs: OpenPr[] }>();
    listings.set(pass.tenantId, listed);
    const key = `${sourceOf(record)}\n${record.name}`;
    const last = listed.get(key);
    if (last && !deps.activity.stale(pass.tenantId, sourceOf(record), record.name, last.at)) return last.prs;
    listed.delete(key);
    const at = deps.now().getTime();
    const prs = await pass.openHeads(record);
    listed.set(key, { at, prs });
    return prs;
  }

  /** The newest verdict recorded on the head. */
  function latestVerdict(recorded: readonly VerdictRecord[], repo: string, row: PrTriageRow) {
    return recorded.filter((verdict) => verdict.repo === repo && verdict.number === row.number && verdict.headSha === row.headSha).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  }

  /** Queues a settled head whose CI the verdict waited on once its build statuses are no longer pending. */
  async function pollBuilds(pass: TenantPass, repo: LoadedRepo, plan: RepoPlan): Promise<void> {
    const name = repo.record.name;
    const now = deps.now().getTime();
    const triaged = plan.rows.filter((row) => row.status === "triaged");
    const recorded = (await deps.verdicts.latest(pass.tenantId, triaged.map((row) => ({ repo: name, number: row.number })))).filter((verdict) => verdict.source === deps.source);
    for (const row of triaged) {
      const key = `${pass.tenantId}\n${name}\n${runKey(row.number, row.headSha)}`;
      const verdict = latestVerdict(recorded, name, row);
      if (!verdict || !waitsOnCi(verdict)) {
        buildPolls.delete(key);
        continue;
      }
      const poll = buildPolls.get(key) ?? { polls: 0, at: verdict.startedAt.getTime() };
      if (poll.polls >= deps.policy.maxAttempts || now - poll.at < Math.min(deps.policy.unconfirmedRetryMs * 2 ** poll.polls, deps.policy.backoffMaxMs)) continue;
      let ci: ReturnType<typeof summarizeChecks>;
      try {
        ci = summarizeChecks(await deps.headChecks(pass.tenantId, repo.record, row.headSha));
      } catch (err) {
        deps.log({ level: "warn", msg: "build_status_unread", tenantId: pass.tenantId, repo: name, pr: row.number, headSha: row.headSha, error: String(err) });
        continue;
      }
      const decided = verdict.checks.find((check) => check.check === "ci-green")!.result;
      // Cancelled CI waits on a person re-running it, however late, so its reads are not counted toward giving up.
      if (readCancelled(verdict) && ci === "cancelled") {
        buildPolls.set(key, { polls: poll.polls, at: now });
        continue;
      }
      // Pending stays pending and failed stays failed until a build changes; a red build turning green is the change worth a run.
      if (ci === "pending" || (decided === "fail" && ci === "failure")) {
        buildPolls.set(key, { polls: poll.polls + 1, at: now });
        continue;
      }
      buildPolls.delete(key);
      requeue(plan, row, BUILD_STATUS_CHANGED, deps.now(), deps.policy);
    }
  }

  async function loadRepo(pass: TenantPass, repo: EnabledRepo): Promise<LoadedRepo | undefined> {
    const read = await deps.readCheckPack(pass.tenantId, repo.record.name, sourceOf(repo.record));
    const pauseLabel = read.status === "ok" ? read.pauseLabel : undefined;
    // A paused pull request is left out like a draft, so its rows go and nothing retries it until its label comes off.
    const prs = (await openPrs(pass, repo.record)).filter((pr) => !pr.draft && !(pauseLabel !== undefined && pr.labels?.includes(pauseLabel)));
    // Without a policy, or with every rule off, triage has nothing to decide: no run starts and nothing is written to the pull request.
    const key = `${pass.tenantId}\n${repo.record.name}`;
    if (read.status === "ok" && hasEnabledRules(read.pack)) {
      skippedRepos.delete(key);
      const stored = await deps.store.load(pass.tenantId, triageStateKey(repo.record));
      return { ...repo, pack: read.pack, automatic: read.automatic, source: read.source, ...(read.policyWorkflow && { policyWorkflow: read.policyWorkflow }), ...(read.pauseLabel && { pauseLabel: read.pauseLabel }), prs, stored };
    }
    // A policy triage can't read is mailed in place of a pack, so every open head is marked failed.
    if (read.status === "invalid") {
      skippedRepos.delete(key);
      return { ...repo, policyUnreadable: read.reason, automatic: read.automatic, prs, stored: await deps.store.load(pass.tenantId, triageStateKey(repo.record)) };
    }
    const skipped = read.status === "ok" ? "triage_skipped_no_rules" : "triage_skipped_no_policy";
    // Once per repository, and again only once a policy or rule came and went, so a repository left unset stays quiet.
    if (skippedRepos.get(key) !== skipped) deps.log({ level: "info", msg: skipped, tenantId: pass.tenantId, repo: repo.record.name, pulls: prs.map((pr) => pr.number) });
    skippedRepos.set(key, skipped);
    return undefined;
  }

  /**
   * Writes the plan's queued heads before any mail goes out, so a request
   * arriving meanwhile sees them queued. When someone wrote first, their rows
   * are reloaded and a head they already queued or started is left to them;
   * refused again, nothing is mailed this pass.
   */
  async function claim(tenantId: string, repo: string, stored: LoadedTriageState, plan: RepoPlan): Promise<Claimed | undefined> {
    const claimed = { rows: plan.rows, version: stored.version, enqueue: plan.enqueue };
    if (JSON.stringify(plan.rows) === JSON.stringify(stored.rows)) return claimed;
    try {
      return { ...claimed, version: await deps.store.save(tenantId, repo, plan.rows, stored.version) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
    const fresh = await deps.store.load(tenantId, repo);
    const theirs = new Map(fresh.rows.map((row) => [headKey(row), row]));
    const headOf = (queued: QueuedPr) => headKey(plan.rows.find((row) => row.number === queued.number)!);
    const left = new Set(plan.enqueue.map(headOf).filter((key) => theirs.has(key) && inFlight(theirs.get(key)!)));
    const rows = mergeRows(fresh.rows, plan.rows.filter((row) => !left.has(headKey(row))));
    try {
      const version = await deps.store.save(tenantId, repo, rows, fresh.version);
      deps.log({ level: "info", msg: "triage_state_merged", tenantId, repo, left: left.size });
      return { rows, version, enqueue: plan.enqueue.filter((queued) => !left.has(headOf(queued))) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
      deps.log({ level: "warn", msg: "triage_state_conflict", tenantId, repo });
      return undefined;
    }
  }

  async function deliverRepo(pass: TenantPass, repo: LoadedRepo, plan: RepoPlan): Promise<void> {
    const key = triageStateKey(repo.record);
    const claimed = await claim(pass.tenantId, key, repo.stored, plan);
    if (claimed === undefined) return;
    const headShaOf = (queued: QueuedPr) => claimed.rows.find((row) => row.number === queued.number)!.headSha;
    for (const queued of claimed.enqueue) {
      const headSha = headShaOf(queued);
      const mailed = { items: [{ prNumber: queued.number, headSha }], ...(queued.noWait && { noWait: true }) };
      const payload = "pack" in repo ? mailPayload(repo.record, repo.policy, repo, mailed) : unreadablePayload(repo.record, repo.policy, repo, mailed);
      try {
        await deps.send({ tenantId: pass.tenantId, repo: key, number: queued.number, headSha, record: repo.record, payload });
      } catch (err) {
        if (err instanceof GithubRateLimited) throw err;
        deps.log({ level: "error", msg: "forward_failed", tenantId: pass.tenantId, repo: repo.record.name, pr: queued.number, headSha, error: String(err) });
        await failDelivery(deps.store, { tenantId: pass.tenantId, repo: key, number: queued.number, headSha }, err, deps.now());
        continue;
      }
      deps.log({ level: "info", msg: "triage_requeued", tenantId: pass.tenantId, repo: repo.record.name, pr: queued.number, headSha, reason: queued.reason });
    }
  }

  /** True when the pass is worth repeating soon: a repository's pass failed. */
  async function reconcileTenant(tenant: ReconcileTenant): Promise<boolean> {
    const repos = enabledRepos(tenant.config, deps.source);
    if (repos.length === 0) return false;
    const listener = await deps.listener(tenant.id, deps.source);
    if (!listener) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_listener" });
      return false;
    }
    let openHeads: OpenHeadsReader | undefined;
    try {
      openHeads = await deps.openHeadsFor(tenant.id);
    } catch (err) {
      listings.delete(tenant.id);
      throw err;
    }
    if (!openHeads) {
      listings.delete(tenant.id);
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_source_credential" });
      return false;
    }
    const pass: TenantPass = { tenantId: tenant.id, openHeads };
    const loaded: LoadedRepo[] = [];
    let failed = false;
    for (const repo of repos) {
      try {
        const repoLoaded = await loadRepo(pass, repo);
        if (repoLoaded) loaded.push(repoLoaded);
      } catch (err) {
        if (reconcileFailed({ tenantId: tenant.id, repo: repo.record.name }, err)) failed = true;
      }
    }
    const pulls = loaded.flatMap((repo) => repo.prs.map((pr) => ({ source: deps.source, repo: repo.record.name, number: pr.number })));
    const managed = await deps.managerRuns(tenant.id, pulls);
    const plans = planTenant({
      repos: loaded.map((repo) => ({ name: repo.record.name, prs: repo.prs, rows: repo.stored.rows })),
      runs: managed.byRepo,
      now: deps.now(),
      policy: deps.policy,
    });
    for (const repo of loaded) {
      try {
        await pollBuilds(pass, repo, plans.get(repo.record.name)!);
        await deliverRepo(pass, repo, plans.get(repo.record.name)!);
      } catch (err) {
        if (reconcileFailed({ tenantId: tenant.id, repo: repo.record.name }, err)) failed = true;
      }
    }
    return failed;
  }

  return async function reconcileTriage(): Promise<ReconcileOutcome> {
    let retry = false;
    limitedUntil = undefined;
    for (const tenant of await deps.tenants()) {
      try {
        if (await reconcileTenant(tenant)) retry = true;
      } catch (err) {
        if (reconcileFailed({ tenantId: tenant.id }, err)) retry = true;
      }
    }
    if (limitedUntil === undefined) return { retry };
    if (limitedUntil !== loggedLimit) deps.log({ level: "warn", msg: "triage_github_rate_limited", resetAt: new Date(limitedUntil).toISOString() });
    loggedLimit = limitedUntil;
    return { retry, retryAt: limitedUntil };
  };
}
