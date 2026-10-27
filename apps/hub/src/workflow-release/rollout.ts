// Rolls a workspace onto the hub build's release: publishes it as the workspace's system principal, deploys each
// connected host's listener from it once the running one differs, waits for it to start and stops what it replaces.
import { schema } from "@intx/db";
import { errorText } from "@corbits/common";
import { chainOf, offeringsIn, publishable, TRIAGE_LISTENERS, type DeployedVersions, type ModelInfo, type PublishedSource, type RepoSource } from "@corbits/triage-contracts";
import { revokeHumanDeployers } from "../deployer-role.js";
import { publishRelease, type Bundle, type PublishDeps, type Publisher } from "./publish.js";

/** A live deployment of a workflow and the source asset commit it runs; `cancelling` once its stop was requested. */
export type Deployment = { runId: string; createdAt: Date; cancelling: boolean; source: { assetId: string; commitSha: string } | null };

export type DeployRequest = { tenantId: string; principalId: string; assetId: string; commitSha: string; packageName: string; entry: string; offerings: { ids: string[]; defaultId: string } };

/** `live` once the deployment runs, `ended` once it stopped or failed without running. */
export type DeployState = "starting" | "live" | "ended";

/** A deployment as stock's lifecycle status reports it; `cancellationDeadline` is set once its stop was requested. */
export type RunStop = { status: string; cancellationDeadline: string | null };

/** Releases a held workspace lock. */
export type Unlock = () => Promise<void>;

/** `busy` when another hub process held the workspace; `failed` names the hosts whose roll failed. */
export type RollOutcome = { busy: boolean; failed: RepoSource[] };

type Rollout = DeployedVersions["rollouts"][number];

type RolloutDeps = PublishDeps & {
  bundle: Bundle;
  /** The workspace's system principal, set up to publish and deploy. */
  publisher: (tenantId: string) => Promise<Publisher>;
  models: (tenantId: string) => Promise<ModelInfo[]>;
  connectedSources: (tenantId: string) => Promise<RepoSource[]>;
  deployments: (tenantId: string, workflow: string) => Promise<Deployment[]>;
  deploy: (request: DeployRequest) => Promise<string>;
  state: (runId: string) => Promise<DeployState>;
  cancel: (tenantId: string, runId: string) => Promise<void>;
  /** Stock's lifecycle status of the deployment; null once it is gone. */
  stop: (tenantId: string, runId: string) => Promise<RunStop | null>;
  /** Takes the workspace's lock across hub processes; undefined while another holds it. */
  lock: (tenantId: string) => Promise<Unlock | undefined>;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
};

/** What a person reads when a host's roll failed; the log line carries the cause. */
const ROLL_FAILED = "Updating Triage failed; see the hub log.";

/** A new listener that is not live by then is stopped, and the one before it keeps running. */
export const START_DEADLINE_MS = 5 * 60_000;
const START_POLL_MS = 2_000;

/** Stock's `unreachableStopGraceMs`, which the hub leaves at its default: how long past its deadline stock tries a stop. */
const STOP_GRACE_MS = 60_000;

/**
 * Whether a deployment whose stop was requested is still live after stock stopped trying to stop it, counted from the
 * cancellation deadline stock set rather than from when the hub asked.
 */
export function stopOverdue(run: RunStop, now: Date): boolean {
  if (!schema.isLiveWorkflowRunStatus(run.status) || run.cancellationDeadline === null) return false;
  return now.getTime() >= Date.parse(run.cancellationDeadline) + STOP_GRACE_MS;
}

/** Each host's workflows from before the listener, which nothing mails any more. */
const REPLACED: Record<RepoSource, readonly string[]> = {
  github: ["pr-triage", "pr-triage-github", "pr-triage-historical", "pr-code-review-github", "pr-workflow-anthropic-github"],
  "bitbucket-datacenter": ["pr-triage-bitbucket-datacenter", "pr-code-review-bitbucket-datacenter", "pr-workflow-anthropic-bitbucket-datacenter"],
};

function newestFirst(a: Deployment, b: Deployment): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.runId.localeCompare(a.runId);
}

function runsRelease(deployment: Deployment, listener: PublishedSource): boolean {
  return deployment.source?.assetId === listener.assetId && deployment.source.commitSha === listener.commitSha;
}

export function createWorkflowRollout(deps: RolloutDeps) {
  const rollouts = new Map<string, Map<RepoSource, Rollout>>();

  function record(tenantId: string, rollout: Rollout): void {
    const hosts = rollouts.get(tenantId) ?? new Map<RepoSource, Rollout>();
    hosts.set(rollout.source, rollout);
    rollouts.set(tenantId, hosts);
  }

  async function liveOf(tenantId: string, workflow: string): Promise<Deployment[]> {
    return (await deps.deployments(tenantId, workflow)).filter((row) => !row.cancelling).sort(newestFirst);
  }

  /** A listener this roll deployed that ends or misses the deadline fails the roll, and the listeners before it keep running. */
  async function waitUntilStarted(tenantId: string, runId: string): Promise<void> {
    const deadline = deps.now().getTime() + START_DEADLINE_MS;
    while (deps.now().getTime() < deadline) {
      const state = await deps.state(runId);
      if (state === "live") return;
      if (state === "ended") throw new Error(`Listener ${runId} ended before it started.`);
      await deps.sleep(START_POLL_MS);
    }
    await deps.cancel(tenantId, runId);
    throw new Error(`Listener ${runId} did not start within five minutes and was stopped.`);
  }

  /**
   * Waits until a deployment whose stop was requested ends; one whose deadline stock has not set yet is still being
   * stopped. One stock gave up stopping stays live, and is only logged: nothing the hub may do stops it.
   */
  async function waitUntilStopped(tenantId: string, source: RepoSource, workflow: string, runId: string): Promise<void> {
    for (;;) {
      const run = await deps.stop(tenantId, runId);
      if (!run || !schema.isLiveWorkflowRunStatus(run.status)) return;
      if (stopOverdue(run, deps.now())) {
        if (workflow === TRIAGE_LISTENERS[source]) deps.log({ level: "warn", msg: "listener_cancel_stuck", tenantId, source, deployment: runId });
        else deps.log({ level: "warn", msg: "rollout_cancel_stuck", tenantId, source, workflow, deployment: runId });
        return;
      }
      await deps.sleep(START_POLL_MS);
    }
  }

  /** The host's other listeners and the workflows they replaced stop, and the host is recorded as on the release. */
  async function settle(tenantId: string, source: RepoSource, kept: string, msg: string): Promise<void> {
    const stopped: Array<{ workflow: string; runId: string }> = [];
    for (const workflow of [TRIAGE_LISTENERS[source], ...REPLACED[source]]) {
      for (const live of await liveOf(tenantId, workflow)) {
        if (live.runId === kept) continue;
        await deps.cancel(tenantId, live.runId);
        stopped.push({ workflow, runId: live.runId });
      }
    }
    await Promise.all(stopped.map((run) => waitUntilStopped(tenantId, source, run.workflow, run.runId)));
    record(tenantId, { source, at: deps.now().toISOString() });
    deps.log({ level: "info", msg, tenantId, source, deployment: kept });
  }

  /** Whether the host's listener runs once the roll is done. */
  async function rollHost(publisher: Publisher, source: RepoSource, models: readonly ModelInfo[], published: readonly PublishedSource[], redeploy: boolean): Promise<boolean> {
    const { tenantId } = publisher;
    const workflow = TRIAGE_LISTENERS[source];
    const listener = published.find((row) => row.workflow === workflow);
    const chain = chainOf(workflow);
    const offerings = chain && offeringsIn(models, chain.models);
    if (!listener || !chain || !offerings) throw new Error(`The hub build did not publish ${workflow}.`);
    const [newest] = await liveOf(tenantId, workflow);
    // A roll cut short, as by a hub restart, can leave its listener live beside the one it replaces. The roll did not
    // deploy that listener, so it neither waits on it nor stops it.
    if (!redeploy && newest && runsRelease(newest, listener)) {
      await settle(tenantId, source, newest.runId, "workflow_release_current");
      return (await deps.state(newest.runId)) === "live";
    }
    const runId = await deps.deploy({ ...publisher, assetId: listener.assetId, commitSha: listener.commitSha, packageName: chain.packageName, entry: chain.entry, offerings });
    deps.log({ level: "info", msg: "workflow_release_deployed", tenantId, source, deployment: runId, assetId: listener.assetId, commitSha: listener.commitSha });
    await waitUntilStarted(tenantId, runId);
    await settle(tenantId, source, runId, "workflow_release_rolled");
    return true;
  }

  function failed(tenantId: string, sources: readonly RepoSource[], error: unknown): RepoSource[] {
    for (const source of sources) record(tenantId, { source, at: deps.now().toISOString(), error: ROLL_FAILED });
    deps.log({ level: "error", msg: "workflow_release_failed", tenantId, sources, error: errorText(error) });
    return [...sources];
  }

  async function rollLocked(tenantId: string, redeploy: ReadonlySet<RepoSource>): Promise<RepoSource[]> {
    const models = await deps.models(tenantId);
    // A listener runs on the decision model, so a host is left until the workspace has one.
    const sources = (await deps.connectedSources(tenantId)).filter((source) => publishable(models, TRIAGE_LISTENERS[source]));
    if (sources.length === 0) return [];
    let publisher: Publisher;
    let published: PublishedSource[];
    try {
      publisher = await deps.publisher(tenantId);
      published = await publishRelease(deps, publisher, deps.bundle, models);
    } catch (error) {
      return failed(tenantId, sources, error);
    }
    const failures: RepoSource[] = [];
    let running = true;
    for (const source of sources) {
      try {
        if (!(await rollHost(publisher, source, models, published, redeploy.has(source)))) running = false;
      } catch (error) {
        failures.push(...failed(tenantId, [source], error));
      }
    }
    if (failures.length === 0 && running) await revokeHumanDeployers(deps.db, tenantId, deps.log);
    return failures;
  }

  /**
   * Rolls the workspace onto the build's release; each host in `redeploy` starts its listener again even when it runs
   * the release, since a running listener keeps the credentials it launched with. One roll per workspace runs at a
   * time, across hub processes too.
   */
  async function roll(tenantId: string, redeploy: ReadonlySet<RepoSource>): Promise<RollOutcome> {
    const unlock = await deps.lock(tenantId);
    if (!unlock) {
      deps.log({ level: "info", msg: "workflow_release_busy", tenantId });
      return { busy: true, failed: [] };
    }
    try {
      return { busy: false, failed: await rollLocked(tenantId, redeploy) };
    } finally {
      await unlock();
    }
  }

  function rolloutsOf(tenantId: string): Rollout[] {
    return [...(rollouts.get(tenantId)?.values() ?? [])];
  }

  return { roll, rollouts: rolloutsOf };
}

type Timing = { quietMs: number; retryMs: number; concurrency: number; random: () => number };

type Pending = { timer?: ReturnType<typeof setTimeout>; due: number; redeploy: Set<RepoSource>; running?: Promise<void>; again: boolean };

/**
 * Rolls workspaces in the background, at most `concurrency` at once across the hub. A workspace rolls once its changes
 * go quiet, so a key saved as several writes rolls once, and again after a roll that a request arrived during. A roll
 * that failed, or found the workspace held, is tried again `retryMs` later, give or take 30%, and the hosts it was to
 * start again stay waiting until a roll of them succeeds.
 */
export function createRolloutQueue(rollout: { roll: (tenantId: string, redeploy: ReadonlySet<RepoSource>) => Promise<RollOutcome> }, timing: Timing, log: (entry: Record<string, unknown>) => void) {
  const pending = new Map<string, Pending>();
  const waiting: Array<() => void> = [];
  let active = 0;

  function stateOf(tenantId: string): Pending {
    const found = pending.get(tenantId);
    if (found) return found;
    const created: Pending = { due: 0, redeploy: new Set(), again: false };
    pending.set(tenantId, created);
    return created;
  }

  async function takeSlot(): Promise<void> {
    if (active < timing.concurrency) {
      active += 1;
      return;
    }
    await new Promise<void>(function queue(resolve) {
      waiting.push(resolve);
    });
  }

  /** Hands the slot straight to the next roll waiting, if any. */
  function freeSlot(): void {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  /** A request restarts the quiet window; a retry leaves a roll already due sooner as it is. */
  function schedule(tenantId: string, redeploy: Iterable<RepoSource>, ms: number, restart: boolean): void {
    const state = stateOf(tenantId);
    for (const source of redeploy) state.redeploy.add(source);
    const due = Date.now() + ms;
    if (!restart && state.timer && state.due <= due) return;
    clearTimeout(state.timer);
    state.due = due;
    state.timer = setTimeout(function rollWhenDue() {
      state.timer = undefined;
      void run(tenantId);
    }, ms);
  }

  async function runOnce(tenantId: string, state: Pending): Promise<void> {
    const redeploy = new Set(state.redeploy);
    state.redeploy.clear();
    let outcome: RollOutcome = { busy: true, failed: [] };
    await takeSlot();
    try {
      outcome = await rollout.roll(tenantId, redeploy);
    } catch (error) {
      log({ level: "error", msg: "workflow_release_failed", tenantId, error: errorText(error) });
    } finally {
      freeSlot();
    }
    if (!outcome.busy && outcome.failed.length === 0) return;
    const retryMs = Math.round(timing.retryMs * (0.7 + 0.6 * timing.random()));
    log({ level: "info", msg: "workflow_release_retry", tenantId, inMs: retryMs });
    schedule(tenantId, outcome.busy ? redeploy : outcome.failed.filter((source) => redeploy.has(source)), retryMs, false);
  }

  async function drain(tenantId: string, state: Pending): Promise<void> {
    do {
      state.again = false;
      await runOnce(tenantId, state);
    } while (state.again);
    state.running = undefined;
  }

  /** Rolls now, or after the roll already running; resolves once the workspace's rolls are done. */
  function run(tenantId: string): Promise<void> {
    const state = stateOf(tenantId);
    if (state.running) {
      state.again = true;
      return state.running;
    }
    state.running = drain(tenantId, state);
    return state.running;
  }

  /** `redeploy` names the hosts whose listeners start again, with new credentials. */
  function request(tenantId: string, redeploy: Iterable<RepoSource>): void {
    schedule(tenantId, redeploy, timing.quietMs, true);
  }

  /** Rolls a workspace with no roll running or due, as when its listener stopped on its own. */
  function ensure(tenantId: string): void {
    const state = stateOf(tenantId);
    if (state.running || state.timer) return;
    schedule(tenantId, [], timing.quietMs, true);
  }

  /**
   * Starts the host's listener again unless a roll is running, which may already be replacing it, or one due already
   * starts it again. Whether this asked for it.
   */
  function replace(tenantId: string, source: RepoSource): boolean {
    const state = stateOf(tenantId);
    if (state.running || state.redeploy.has(source)) return false;
    if (state.timer) state.redeploy.add(source);
    else schedule(tenantId, [source], timing.quietMs, true);
    return true;
  }

  return { run, request, ensure, replace };
}
