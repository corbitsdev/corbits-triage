// Queues one open pull request's head on the live pr-triage deployment at a
// maintainer's request. The row is marked queued before the mail goes out so
// repeated clicks and reconcile passes see it; a failed mail puts it back.
// Attempts are left alone: a head the hub gave up on is only ever retried here.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { repoPolicy, type PrTriageRow } from "@corbits/triage-contracts";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { isStuck, runKey, type ReconcilePolicy } from "./reconcile-plan.js";
import { repoRecords, triageNs } from "./tenant-config.js";
import type { PullHeadReader } from "./tenant-open-heads.js";
import type { LiveDeployment } from "./triage-reconciler.js";
import type { ObservedRuns } from "./triage-runs.js";
import { TriageStateConflictError, type LoadedTriageState, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

export const GITHUB_PR_TRIAGE_PATH = "/api/integrations/github-triage";

const Body = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" });

export type GithubPrTriageDeps = PortalCredentialDeps & {
  pullHead: PullHeadReader;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  liveDeployment: (tenantId: string) => Promise<LiveDeployment | null>;
  observeRuns: (anchorRunId: string, domain: string) => Promise<ObservedRuns>;
  store: TriageStateStore;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/** A head the hub queued and has not yet given up waiting on; later the reconciler marks it failed and queues it again itself. */
function isQueuedSince(row: PrTriageRow | undefined, now: Date, policy: ReconcilePolicy): boolean {
  return row?.status === "queued" && row.queuedAt !== undefined && now.getTime() - new Date(row.queuedAt).getTime() < policy.unstartedAfterMs;
}

function queuedAgain(prior: PrTriageRow | undefined, number: number, headSha: string, at: string): PrTriageRow {
  if (prior === undefined) return { number, headSha, status: "queued", attempts: 0, firstSeenAt: at, queuedAt: at, updatedAt: at };
  // The last run and version stay named so the plan can tell this head from one it has never seen.
  const { error: _error, ...rest } = prior;
  return { ...rest, status: "queued", queuedAt: at, updatedAt: at };
}

function rowOf(rows: readonly PrTriageRow[], number: number, headSha: string): PrTriageRow | undefined {
  return rows.find((row) => row.number === number && row.headSha === headSha);
}

/** The rows with this head's row replaced, added, or removed when `next` is undefined. */
function withRow(rows: readonly PrTriageRow[], number: number, headSha: string, next: PrTriageRow | undefined): PrTriageRow[] {
  const others = rows.filter((row) => !(row.number === number && row.headSha === headSha));
  return next === undefined ? others : [...others, next];
}

type Remembered = { prior: PrTriageRow | undefined; rows: PrTriageRow[]; version: TriageStateVersion };

/** Puts the head's prior row back after a mail that did not go out; refused as stale, it is retried once on a fresh load. */
async function restore(store: TriageStateStore, tenantId: string, repo: string, number: number, headSha: string, remembered: Remembered): Promise<void> {
  try {
    await store.save(tenantId, repo, withRow(remembered.rows, number, headSha, remembered.prior), remembered.version);
    return;
  } catch (err) {
    if (!(err instanceof TriageStateConflictError)) throw err;
  }
  const fresh = await store.load(tenantId, repo);
  await store.save(tenantId, repo, withRow(fresh.rows, number, headSha, remembered.prior), fresh.version);
}

export function createGithubPrTriage(deps: GithubPrTriageDeps) {
  return async function handle(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const body = Body(await readJson(req));
    if (body instanceof type.errors) return failure(400, "invalid_request", body.summary);
    const { repo, number } = body;
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
    if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
    const policy = repoPolicy(record);
    if (!policy.enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");
    const pack = await deps.readCheckPack(tenantId, repo);
    if (pack.status === "corrupt") return failure(409, "check_pack_unreadable", "This repository's check pack is unreadable. Replace it on the repository page.");
    if (pack.status !== "ok") return failure(409, "needs_setup", "This repository still needs check setup.");
    const deployment = await deps.liveDeployment(tenantId);
    if (!deployment) return failure(503, "service_not_running", "The pr-triage service is not running.");

    let openHead: string | undefined;
    try {
      openHead = await deps.pullHead(appJson, record, number);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failure(502, "github_failed", `Could not read ${repo}#${number} from GitHub: ${message}.`);
    }
    if (openHead === undefined) return failure(409, "pull_request_not_open", `${repo}#${number} is not an open pull request.`);
    const headSha = openHead;

    const now = deps.now();
    const runs = (await deps.observeRuns(deployment.runId, tenant.domain)).byRepo.get(repo)?.get(runKey(number, headSha)) ?? [];
    if (runs.some((run) => run.status === "running" && !isStuck(run, now, deps.policy))) {
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    /** Marks the head queued on top of what is stored now; a write refused as stale is retried once on a fresh load, gate included. */
    async function remember(state: LoadedTriageState, retry: boolean): Promise<Remembered | Response> {
      const prior = rowOf(state.rows, number, headSha);
      if (isQueuedSince(prior, now, deps.policy)) return failure(409, "already_queued", `${repo}#${number} is already queued for triage.`);
      const rows = withRow(state.rows, number, headSha, queuedAgain(prior, number, headSha, now.toISOString()));
      try {
        return { prior, rows, version: await deps.store.save(tenantId, repo, rows, state.version) };
      } catch (err) {
        if (!(err instanceof TriageStateConflictError)) throw err;
        if (retry) return remember(await deps.store.load(tenantId, repo), false);
        return failure(409, "conflict", `${repo}#${number} was just updated by the hub. Try again.`);
      }
    }

    const remembered = await remember(await deps.store.load(tenantId, repo), true);
    if (remembered instanceof Response) return remembered;
    try {
      await deps.deliver(tenantId, deployment.address, mailPayload(repo, policy, pack.pack, { prNumber: number, headSha }));
    } catch (err) {
      deps.log({ level: "error", msg: "triage_request_failed", tenantId, repo, pr: number, headSha, error: String(err) });
      try {
        await restore(deps.store, tenantId, repo, number, headSha, remembered);
      } catch (restoreErr) {
        deps.log({ level: "error", msg: "triage_state_restore_failed", tenantId, repo, pr: number, headSha, error: String(restoreErr) });
      }
      const reason = err instanceof Error ? err.message : String(err);
      return failure(isRunTriggerUnroutable(err) ? 503 : 502, isRunTriggerUnroutable(err) ? "service_not_running" : "hub_unavailable", `Could not queue ${repo}#${number}: ${reason}. Try again.`);
    }
    deps.log({ level: "info", msg: "triage_requested", tenantId, principalId, repo, pr: number, headSha });
    return Response.json({ status: "queued", headSha }, { status: 202 });
  };
}
