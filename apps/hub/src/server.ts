// Composition over the stock Interchange hub bootstrap (./interchange-hub.ts).
// GitHub manifest start/callback and PR actions are custom domain routes
// because GitHub must return a one-time code to a confidential server before
// any browser can observe it. GitHub-signed hook requests go to the legacy
// bridge until upstream ships a GitHub verifier; other source hosts post to
// /api/hooks/:provider/:tenantId (./provider-hooks). Every other /api/* path falls
// through to stock unchanged.
//
// createHubServer takes no workflow/tool registry: the portal deploys the
// triage workflows per tenant and the bridge finds them by name.
// EXPECTED_DEPLOYMENT_SET is that contract, referenced (not stringly typed) so
// a workflow rename or tool-id change breaks the build here.
import { resolve } from "node:path";
import { authorize, timeWindowEvaluator } from "@intx/authz";
import { createGrantStore, createWorkflowRunLaunchSpecStore, schema } from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { hexDecode } from "@intx/types";
import { and, eq } from "drizzle-orm";
import { createMailTriggeredRunGrantsMaterializer, createRequireGrant } from "@intx/hub-api";
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
} from "@corbits/webhooks";
import {
  createArtifactRoutes,
  InlineContentStore,
  runArtifactMigrations,
} from "@corbits/artifacts";
import {
  createCronRoutes,
  createCronTicker,
  createRunTriggerCronDeliver,
  type CronTicker,
} from "@corbits/cron";
import { runCronMigrations } from "@corbits/cron/migrations";
import { E2B_PLACE } from "@corbits/provisioner-e2b";
import { RAILWAY_PLACE } from "@corbits/provisioner-railway";
import { TRIAGE_MAIL_SENDER, type RepoSource } from "@corbits/triage-contracts";
import { createArtifactGrants, grantAdminsPolicyWrites } from "./artifact-grants.js";
import { createInterchangeHub } from "./interchange-hub.js";
import { connectDockerSidecars, dockerPlaces, sweepDockerSidecarsOf } from "./sidecar/docker.js";
import { connectE2bSidecars, tendE2bSidecarsOf, type E2bSidecarProvisioner } from "./sidecar/e2b.js";
import { createLocalProcessSidecarProvisioner } from "./sidecar/local-provisioner.js";
import { connectRailwaySidecars, sweepRailwaySidecarsOf, type RailwaySidecarProvisioner } from "./sidecar/railway.js";
import { createHostCapacity } from "./sidecar/host-capacity.js";
import { createLocalSidecarManifestStore } from "./sidecar/manifest-store.js";
import { restoreLocalSidecars } from "./sidecar/restore.js";
import { createSpawnLocalSidecar } from "./sidecar/spawn.js";
import { SIDECAR_ADAPTER_MANIFEST } from "./sidecar-config.js";
import { createPortalHandler, isPortalRequest, withPortalCors } from "./portal.js";
import { createInstallationSync } from "./github/installation-sync.js";
import { authMethods } from "./auth.js";
import { createIntegrationsApp, INTEGRATIONS_PREFIX } from "./integrations/app.js";
import { createBitbucketIntegration } from "./bitbucket-datacenter/integration.js";
import { checkedBitbucketSpawner, createTenantBitbucket } from "./bitbucket-datacenter/tenant-bitbucket.js";
import { createPrWorkflowRouter, PR_WORKFLOW_VARIANTS, prWorkflowVariantOf } from "./github/pr-workflow.js";
import { codeReviewKeys, codeReviewSources, codeReviewWorkflowFor, connectedSources, createSourceDeployments, TRIAGE_WORKFLOWS, triageWorkflowFor, triageWorkflowOf, type TriageWorkflow } from "./github/source-workflow.js";
import { createInvitations } from "./invitations/invitations.js";
import { createSmtpEmail } from "./invitations/invite-email.js";
import { createWorkflowDeploy } from "./workflow-deploy.js";
import { createCodeReviewPlace, createCodeReviewPlacement, createCodeReviewRun, createCodeReviewSwitch } from "./code-review.js";
import { createCodeReviewFeed, createPullRequestReader } from "./code-review-feed.js";
import { createCodeReviewRuns } from "./code-review-runs.js";
import { createWorkflowVersions } from "./workflow-versions.js";
import { bitbucketEgressAllowlist, childProcessEnv, databaseConfig, dockerSettings, e2bSettings, emailSettings, interchangeSettings, githubApiOrigin, loadHubEnv, migrationEnv, inviteLinkOrigin, railwaySandboxSettings, signInSettings, triageCoalesceWindow, triageReconcileIntervalMs, triageReconcilePolicy, triageRotateAfterRuns } from "./env.js";
import { HOOK_MOUNT_PATH, createStockHookApp, migrateWebhooks } from "./hooks.js";
import { createBridgeHandler, logJson, withAppLogin } from "./github/bridge.js";
import { createGithubTokenRenewal, GITHUB_TOKEN_RENEW_MS } from "./github/installation-token.js";
import { appKeyWriteRefusal, githubTenants, moveAppKey } from "./github/app-key.js";
import { createGithubAppConnection } from "./github/app-connection.js";
import { createProviderHookApp, isProviderHookPath } from "./provider-hooks/app.js";
import { createProviderHookHandler } from "./provider-hooks/intake.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { createCoalescer, type Coalescer } from "./github/coalescer.js";
import { createCoordinator, type Coordinator, type TriageJob } from "./github/coordinator.js";
import { createWorkerSpawner, releaseOrphanedWorkers } from "./github/worker-spawn.js";
import { DeliveryCache } from "./github/dedupe.js";
import { activeTenants, createDeploymentRotation, latestDeployments, NoLiveDeploymentError, readyMaterializer, recentWorkers, resolveLiveDeployment, resolveLiveDeployments, withWorkflowVersions } from "./github/deployment.js";
import { createGithubOpenPulls, createMemberOpenPulls, createOpenPullsCache, keptOpenPrs } from "./github/open-pulls.js";
import { createRepoReads } from "./github/repo-reads.js";
import { createGithubPrActions } from "./github/pr-actions.js";
import { createGithubHeldDos } from "./github/held-dos.js";
import { createVerdictRecordStore } from "./github/verdict-record-store.js";
import { createSessions } from "./sessions.js";
import { createVerifiedGate } from "./verified-gate.js";
import { createHubOwner } from "./hub-owner.js";
import { migrateTriageTables } from "./triage-db.js";
import { createTriageStats } from "./github/triage-stats.js";
import { createHostReads, createOutcomeReader } from "./github/pr-outcomes.js";
import { createTriageTimeline } from "./github/triage-timeline.js";
import { createAuditLog } from "./audit-log.js";
import { createRunRecorder } from "./github/run-recorder.js";
import { createRecordPass, createTenantObserver, createTenantVersions } from "./github/tenant-observer.js";
import { createTriageVerdicts } from "./github/triage-verdicts.js";
import { createGithubPrDetails } from "./github/pr-details.js";
import { createMergeStates } from "./github/merge-states.js";
import { createGithubPrTriage } from "./github/pr-triage.js";
import { createPolicyFile } from "./github/policy-file.js";
import { createGithubPolicyRead } from "./github/policy-read.js";
import { createBacklogStart, createGithubBacklog } from "./github/backlog-triage.js";
import { fileRefusal, loadCheckPack, settlePolicy } from "./github/check-pack-store.js";
import { createAutomation, grantEnabledKinds } from "./github/automation.js";
import { createReconcileLoop } from "./github/reconcile-loop.js";
import { githubUsage } from "./github/github-usage.js";
import { createTriageReconciler, type ReconcileOutcome } from "./github/triage-reconciler.js";
import { createRepoActivity } from "./github/repo-activity.js";
import { createTenantGithub, createTenantHeadChecks, createTenantOpenHead, createTenantOpenHeads, createTenantOpenPrs } from "./github/tenant-open-heads.js";
import { createSettledStatusReader, createTriageRuns } from "./github/triage-runs.js";
import { createTriageStateStore } from "./github/triage-state-store.js";
import { failHead, markBaseMoved } from "./github/triage-queue.js";
import { createGithubManifestIntegration } from "./github/manifest.js";
import { migrateRepoEnabledFlag, prepareCorbitsTriagePatch, repoRecords, sourceOf, tenantManager, triageNs, type RepoRecord } from "./github/tenant-config.js";
import { workflow as prTriageGithub } from "@corbits/triage-workflows/pr-triage-github";
import { PR_TRIAGE_HISTORICAL_ADDRESS, workflow as prTriageHistoricalWorkflow } from "@corbits/triage-workflows/pr-triage-historical";
import { githubRead } from "@corbits/github-tool";
import { bitbucketRead } from "@corbits/bitbucket-datacenter-tool";

// Per host: a workspace deploys a host's workflow and tools once that host's credential exists; pr-triage-historical
// reads GitHub only. A workspace with both hosts runs both pr-triage workflows. A host's code review deploys while a
// repository of it has code review on.
function variantsOf(source: RepoSource) {
  return PR_WORKFLOW_VARIANTS.filter((variant) => variant.source === source).map((variant) => ({ address: variant.id, id: variant.id }));
}
const EXPECTED_DEPLOYMENT_SET = {
  github: {
    workflows: [
      { address: triageWorkflowFor("github").address, id: prTriageGithub.id },
      { address: PR_TRIAGE_HISTORICAL_ADDRESS, id: prTriageHistoricalWorkflow.id },
      { address: codeReviewWorkflowFor("github").id, id: codeReviewWorkflowFor("github").id },
      ...variantsOf("github"),
    ],
    tools: [githubRead.id],
  },
  "bitbucket-datacenter": {
    workflows: [
      { address: triageWorkflowFor("bitbucket-datacenter").address, id: triageWorkflowFor("bitbucket-datacenter").id },
      { address: codeReviewWorkflowFor("bitbucket-datacenter").id, id: codeReviewWorkflowFor("bitbucket-datacenter").id },
      ...variantsOf("bitbucket-datacenter"),
    ],
    tools: [bitbucketRead.id],
  },
};

// Runs whose trigger and outcome the reconciler remembers between passes.
const TRIAGE_KNOWN_RUNS = 10_000;
const TRIAGE_RETRY_MS = 15_000;
const TRIAGE_RETRY_MAX_MS = 120_000;
/** A repository is listed again once its listing is this old, and every pass once its webhook (the App's, on GitHub) heard nothing this long. */
const TRIAGE_RELIST_QUIET_MS = 30 * 60_000;
/** A listing that started this soon after a repository's webhook is read again, since GitHub's listing can trail it. */
const TRIAGE_RELIST_GRACE_MS = 60_000;
/** How often the live logs of tenants with a pr-triage run in flight are read and recorded, and how stale a shared read may be. */
const TRIAGE_RECORD_MS = 2_000;
const WORKER_FIRE_TIMEOUT_MS = 120_000;
const GITHUB_CALLS_LOG_MS = 60_000;
const WORKER_POLL_MS = 2_000;
/** A tenant whose logs could not be read is left at most this long before the recording loop tries again. */
const TRIAGE_RECORD_MAX_BACKOFF_MS = 5 * 60_000;
/** How often E2B sandboxes are swept and extended; well inside their one-hour timeout. */
const E2B_TEND_MS = 10 * 60_000;
/** A GitHub token that could not be renewed is tried again within its remaining quarter hour. */
const GITHUB_TOKEN_RETRY_MS = 60_000;
const GITHUB_TOKEN_RETRY_MAX_MS = 5 * 60_000;

const ROOT = resolve(import.meta.dir, "../../..");
const V = resolve(ROOT, "vendor/interchange");
const env = loadHubEnv(process.env);
const database = databaseConfig(env);
const githubOrigin = githubApiOrigin(env);

await Bun.$`bunx drizzle-kit migrate`.cwd(`${V}/packages/db`).env({ ...childProcessEnv(env), ...migrationEnv(database) }).quiet();
logJson({ level: "info", msg: "migrations_applied" });
await migrateWebhooks(database, logJson);
{
  const { schema = "public", statementTimeoutMs: _, ...connection } = database;
  await runArtifactMigrations(connection, { schema });
  logJson({ level: "info", msg: "artifact_migrations_applied" });
  await runCronMigrations(connection, { schema });
  logJson({ level: "info", msg: "cron_migrations_applied" });
}

const credentialCipher = createEnvKeyCredentialCipher(hexDecode(env.CREDENTIAL_ENCRYPTION_KEY));
const localSidecarDataRoot = `${env.HUB_DATA_DIR}/local-sidecars`;
const local = createLocalProcessSidecarProvisioner({
  dataRoot: localSidecarDataRoot,
  ...(env.HUB_SIDECAR_STOP_TIMEOUT_MS !== undefined && { stopTimeoutMs: Number(env.HUB_SIDECAR_STOP_TIMEOUT_MS) }),
  spawnSidecar: createSpawnLocalSidecar({
    interchangeDir: V,
    credentialEncryptionKey: env.SIDECAR_CREDENTIAL_ENCRYPTION_KEY,
    processEnv: childProcessEnv(env),
  }),
  manifests: createLocalSidecarManifestStore({
    dataRoot: localSidecarDataRoot,
    cipher: credentialCipher,
    log: logJson,
  }),
  capacity: createHostCapacity({ cgroupRoot: "/sys/fs/cgroup", meminfo: "/proc/meminfo" }),
  adapterManifest: SIDECAR_ADAPTER_MANIFEST,
  log: logJson,
});
const docker = await connectDockerSidecars({ docker: dockerSettings(env), database, adapterManifest: SIDECAR_ADAPTER_MANIFEST });
const dockerUp = "provisioner" in docker ? docker : undefined;
if ("reason" in docker) logJson({ level: "info", msg: "docker_sidecars_off", reason: docker.reason });
const e2bConfig = e2bSettings(env);
const e2b = e2bConfig === undefined ? undefined : await connectE2bSidecars({ e2b: e2bConfig, database, adapterManifest: SIDECAR_ADAPTER_MANIFEST });
if (typeof e2b === "string") logJson({ level: "info", msg: "e2b_sidecars_off", reason: e2b });
const railwaySettings = railwaySandboxSettings(env);
const railway = railwaySettings === undefined ? undefined : await connectRailwaySidecars({ railway: railwaySettings, database, adapterManifest: SIDECAR_ADAPTER_MANIFEST });
if (typeof railway === "string") logJson({ level: "info", msg: "railway_sidecars_off", reason: railway });
// First match wins: workflows and probes that require isolation:workload land on Docker, then E2B, then Railway, the rest on the hub host.
const workloadProvisioners = [dockerUp, e2b, railway].filter((found) => found !== undefined && typeof found !== "string").map((found) => found.provisioner);
const sidecarProvisioners = [local.provisioner, ...workloadProvisioners];

let shuttingDown = false;
let cronTicker: CronTicker | undefined;
let triageLoop: ReturnType<typeof createReconcileLoop> | undefined;
let recordLoop: ReturnType<typeof createReconcileLoop> | undefined;
let tokenLoop: ReturnType<typeof createReconcileLoop> | undefined;
let coalescer: Coalescer | undefined;
let coordinator: Coordinator | undefined;
let e2bTender: ReturnType<typeof setInterval> | undefined;
function logGithubCalls(): void {
  const line = githubUsage.flush();
  if (line) logJson(line);
}
const githubCallsLogger = setInterval(logGithubCalls, GITHUB_CALLS_LOG_MS);
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  cronTicker?.stop();
  triageLoop?.stop();
  recordLoop?.stop();
  tokenLoop?.stop();
  coalescer?.stop();
  coordinator?.stop();
  clearInterval(e2bTender);
  clearInterval(githubCallsLogger);
  try {
    await local.shutdown();
  } finally {
    process.exit(0);
  }
}
function onShutdownSignal(): void {
  void shutdown();
}
process.once("SIGINT", onShutdownSignal);
process.once("SIGTERM", onShutdownSignal);

const portalOrigin = env.PORTAL_ORIGIN === undefined ? [] : [new URL(env.PORTAL_ORIGIN).origin];
const signIn = signInSettings(env);
const email = emailSettings(env);
const smtp = email === undefined ? undefined : createSmtpEmail(email);
const composition = await createInterchangeHub({
  database,
  settings: interchangeSettings(env),
  authConfig: { ...signIn, baseURL: env.BETTER_AUTH_BASE_URL, secret: env.BETTER_AUTH_SECRET, trustedOrigins: portalOrigin, portalOrigin: inviteLinkOrigin(env), ...(smtp && { email: { resetPassword: smtp.passwordReset, verifyEmail: smtp.verifyEmail } }) },
  credentialCipher,
  adapterManifest: SIDECAR_ADAPTER_MANIFEST,
  sidecarProvisioners,
  probeSidecarProvisioners: sidecarProvisioners,
  probeSidecarCapabilityRules: workloadProvisioners.length > 0 ? [{ capability: "isolation:workload", effect: "require" }] : [],
});
const stock = composition.server;
composition.sidecarRouter.events.on("sidecar.allocated.connected", local.connected);

/** The hub's credentials, and the push that takes back from sidecars an App key a read moved to the hub. */
const credentialDeps = {
  db: composition.db,
  cipher: composition.credentialCipher,
  /** A failed push fails the read; the next token renewal sends every holder the credential again. */
  onKeyMoved: async function pushMovedKeyBlank(tenantId: string): Promise<void> {
    try {
      await githubToken.push(tenantId);
    } catch (err) {
      logJson({ level: "error", msg: "github_app_key_blank_push_failed", tenantId, error: String(err) });
      throw err;
    }
  },
};
// App JSON a stock write left where workflows bind it moves to the hub before any sidecar is restored with it.
const movedAppKeys: string[] = [];
for (const tenantId of await githubTenants(composition.db)) {
  if (await moveAppKey(credentialDeps, tenantId)) movedAppKeys.push(tenantId);
}
await restoreLocalSidecars(composition.db, local);
if (dockerUp) logJson({ level: "info", msg: "docker_sidecars_swept", removed: await sweepDockerSidecarsOf(composition.db, dockerUp) });
async function tendE2b(sidecars: E2bSidecarProvisioner): Promise<void> {
  try {
    logJson({ level: "info", msg: "e2b_sidecars_tended", removed: await tendE2bSidecarsOf(composition.db, sidecars) });
  } catch (error) {
    logJson({ level: "error", msg: "e2b_sidecars_tend_failed", error: String(error) });
  }
}
if (e2b !== undefined && typeof e2b !== "string") {
  await tendE2b(e2b);
  e2bTender = setInterval(tendE2b, E2B_TEND_MS, e2b);
}
// Both call Railway, which may be slow or down, so neither holds up the hub. Sandboxes wait for the same build.
async function buildRailwayTemplate(connected: RailwaySidecarProvisioner): Promise<void> {
  try {
    await connected.sandboxes.templateReady();
    logJson({ level: "info", msg: "railway_sidecar_template_built" });
  } catch (error) {
    logJson({ level: "error", msg: "railway_sidecar_template_failed", error: String(error) });
  }
}
async function sweepRailway(connected: RailwaySidecarProvisioner): Promise<void> {
  try {
    const { removed, unsettled } = await sweepRailwaySidecarsOf(composition.db, connected);
    logJson({ level: "info", msg: "railway_sidecars_swept", removed });
    // A later boot sweeps them; until they settle, destroys that might concern them are retried.
    if (unsettled > 0) logJson({ level: "warn", msg: "railway_sidecars_sweep_gave_up", unsettled });
  } catch (error) {
    logJson({ level: "error", msg: "railway_sidecars_sweep_failed", error: String(error) });
  }
}
if (railway !== undefined && typeof railway !== "string") {
  void buildRailwayTemplate(railway);
  void sweepRailway(railway);
}
const requireGrant = createRequireGrant({
  grantStore: createGrantStore(composition.db),
  conditionRegistry: { time_window: timeWindowEvaluator },
});
composition.app.route("/api/tenants/:tenantId", createArtifactRoutes({
  db: composition.db,
  contentStore: InlineContentStore,
  requireGrant,
  onArtifactCreated: createArtifactGrants(now),
}));
composition.app.route("/api/tenants/:tenantId/cron", createCronRoutes({ db: composition.db, requireGrant }));
async function tenantDomain(tenantId: string): Promise<string> {
  const row = await composition.db.query.tenant.findFirst({
    where: eq(schema.tenant.id, tenantId),
  });
  if (!row) throw new Error("tenant not found");
  return row.domain;
}
const systemSender = createTenantSystemSender({
  db: composition.db,
  principalKeyStore: composition.principalKeyStore,
});
function runTriggerDeliverer(senderLocalPart: string) {
  return createRunTriggerDeliverer({
    router: composition.sidecarRouter,
    materialize: readyMaterializer(createMailTriggeredRunGrantsMaterializer({
      db: composition.db,
      principalKeyStore: composition.principalKeyStore,
      grantStore: createGrantStore(composition.db),
    })),
    tenantDomain,
    senderLocalPart,
    systemSender,
  });
}
cronTicker = createCronTicker({
  db: composition.db,
  deliver: createRunTriggerCronDeliver(runTriggerDeliverer("cron")),
  onDeliveryError: function logCronDeliveryError(error, schedule) { logJson({ level: "warn", msg: "cron_delivery_failed", scheduleId: schedule.id, tenantId: schedule.tenantId, error: String(error) }); },
});
cronTicker.start();
await migrateRepoEnabledFlag(composition.db);
await migrateTriageTables(composition.db, database.schema ?? "public");
const automation = createAutomation({ db: composition.db, now });
await automation.startUp();
await grantAdminsPolicyWrites(composition.db, now, logJson);
const verdictRecordStore = createVerdictRecordStore(composition.db);
const portalGrantStore = createGrantStore(composition.db);
const trustedPortalOrigins = [new URL(env.BETTER_AUTH_BASE_URL).origin, ...portalOrigin];
async function authorizePortal(principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  const result = await authorize(portalGrantStore, principalId, tenantId, resource, action, { time_window: timeWindowEvaluator });
  return result.effect === "allow";
}
const githubManifest = createGithubManifestIntegration({
  ...credentialDeps,
  getSession: composition.getSession,
  trustedPortalOrigins,
  githubApiOrigin: githubOrigin,
  publicOrigin: new URL(env.BETTER_AUTH_BASE_URL).origin,
  authorizeCredential: authorizePortal,
  stateSecret: env.BETTER_AUTH_SECRET,
});
const tenantBitbucket = createTenantBitbucket({ ...credentialDeps, fetchImpl: fetch, egressAllowlist: bitbucketEgressAllowlist(env) });
const tenantGithub = createTenantGithub({ ...credentialDeps, githubApiOrigin: githubOrigin });
const pullRequests = createPullRequestReader({ tenantGithub, tenantBitbucket });
const codeReviewRuns = createCodeReviewRuns({ db: composition.db, runReader: composition.runReader, read: pullRequests.withDiff, log: logJson });
const repoReads = createRepoReads(now);
const githubPrActions = createGithubPrActions({
  ...credentialDeps,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
  readCheckPack,
  codeReviews: codeReviewRuns,
  changed: repoReads.changed,
  log: logJson,
});
const githubPrDetails = createGithubPrDetails({
  reads: repoReads,
  ...credentialDeps,
  githubApiOrigin: githubOrigin,
  tenantBitbucket,
  authorize: authorizePortal,
  log: logJson,
});

const mergeStates = createMergeStates({
  reads: repoReads,
  ...credentialDeps,
  githubApiOrigin: githubOrigin,
  tenantBitbucket,
  authorize: authorizePortal,
  log: logJson,
});

const hookDeps = credentialDeps;
const hookApp = createStockHookApp(
  hookDeps,
  composition.principalKeyStore,
  composition.sidecarRouter,
);

const GITHUB_SENDER = TRIAGE_MAIL_SENDER;
const githubDeliverer = runTriggerDeliverer(GITHUB_SENDER);
async function deliverToDeployment(tenantId: string, address: string, payload: unknown): Promise<void> {
  await githubDeliverer.to(address, JSON.stringify(await withAppLogin(composition.db, tenantId, payload)), tenantId, undefined);
}
const githubToken = createGithubTokenRenewal({ ...credentialDeps, githubApiOrigin: githubOrigin, router: composition.sidecarRouter, log: logJson });
for (const tenantId of movedAppKeys) await githubToken.push(tenantId);
tokenLoop = createReconcileLoop(githubToken.renewAll, { intervalMs: GITHUB_TOKEN_RENEW_MS, retryMs: GITHUB_TOKEN_RETRY_MS, retryMaxMs: GITHUB_TOKEN_RETRY_MAX_MS }, logJson);
/** A failed renewal is retried by the token loop. */
async function renewGithubToken(tenantId: string): Promise<void> {
  try {
    await githubToken.renew(tenantId);
  } catch (err) {
    logJson({ level: "error", msg: "github_token_renew_failed", tenantId, error: String(err) });
  }
}
const GITHUB_JOB_WORKFLOWS = new Set([
  triageWorkflowFor("github").id,
  codeReviewWorkflowFor("github").id,
  ...PR_WORKFLOW_VARIANTS.filter((variant) => variant.source === "github").map((variant) => variant.id),
]);
/** A token that could not be renewed may still have time left, so the worker goes ahead and the token loop retries. */
async function readyWorkerCredentials(job: TriageJob): Promise<void> {
  if (!GITHUB_JOB_WORKFLOWS.has(job.workflow)) return;
  try {
    await githubToken.ensure(job.tenantId);
  } catch (err) {
    logJson({ level: "error", msg: "github_token_renew_failed", tenantId: job.tenantId, error: String(err) });
  }
}
/** A hook credential written before hosts names `pr-triage`; its mail goes to the GitHub workflow that replaced it. */
async function sendBridgeMail(tenantId: string, workflow: string, payload: unknown): Promise<void> {
  const id = triageWorkflowOf(workflow)?.id ?? workflow;
  const live = await resolveLiveDeployment(composition.db, tenantId, id);
  if (!live) throw new NoLiveDeploymentError(id);
  await deliverToDeployment(tenantId, live.address, payload);
}
/** The workflow a job's worker is seeded from: a host's triage workflow, by either name it goes by. */
function workflowIdFor(name: string): string {
  const triage = triageWorkflowOf(name);
  if (!triage) throw new Error(`Not a triage workflow: ${name}`);
  return triage.id;
}
/** Every triage and code review mail, whatever started it, runs in a worker of its own. */
async function sendToWorker(job: TriageJob): Promise<void> {
  coordinator!.enqueue(job);
}
/** A paused pull request's job is dropped; the reconciler leaves it alone until its label comes off. */
async function sendTriageMail(job: TriageJob): Promise<void> {
  const routed = await routePrWorkflow({ ...job, workflow: workflowIdFor(job.workflow) });
  if (routed) await sendToWorker(routed);
}
const placeCodeReview = createCodeReviewPlacement(composition.db, composition.sidecarPlugins);
async function codeReviewPlaced(tenantId: string): Promise<boolean> {
  return (await placeCodeReview(tenantId)) !== null;
}
/** Whether the repository's policy file needs the PR workflow, which reviews the code itself. */
async function inPrWorkflow(tenantId: string, repo: string, source: RepoSource): Promise<boolean> {
  const read = await readCheckPack(tenantId, repo, source);
  return read.status === "ok" && read.policyWorkflow !== undefined;
}
// Repositories left switched on send nothing while code review has nowhere to run, nor one the PR workflow reviews.
async function reviewedSources(tenantId: string, record: RepoRecord) {
  if (!(await codeReviewPlaced(tenantId)) || (await inPrWorkflow(tenantId, record.name, sourceOf(record)))) return [];
  return codeReviewSources(composition.db, tenantId);
}
/** The hosts whose PR workflow deploys: a connected repository's policy file needs it, and code review has a place to run. */
async function prWorkflowSources(tenantId: string): Promise<RepoSource[]> {
  if (!(await codeReviewPlaced(tenantId))) return [];
  const tenant = await composition.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
  const sources = new Set<RepoSource>();
  for (const record of repoRecords(triageNs(tenant?.config)).filter((row) => row.connected)) {
    if (await inPrWorkflow(tenantId, record.name, sourceOf(record))) sources.add(sourceOf(record));
  }
  return [...sources];
}
const codeReviewFeed = createCodeReviewFeed({
  reviewed: reviewedSources,
  read: pullRequests.withDiff,
  carries: codeReviewRuns.carries,
  send: sendToWorker,
  log: logJson,
});
const routePrWorkflow = createPrWorkflowRouter({
  credentials: function workspaceCodeReviewKeys(tenantId) {
    return codeReviewKeys(composition.db, tenantId);
  },
  live: async function variantLive(tenantId, workflow) {
    return (await resolveLiveDeployment(composition.db, tenantId, workflow)) !== null;
  },
  readHead: pullRequests.head,
  readPull: pullRequests.withDiff,
  log: logJson,
});
const tenantSources = { ...credentialDeps, githubApiOrigin: githubOrigin, tenantBitbucket };
const tenantOpenPrs = keptOpenPrs(createTenantOpenPrs(tenantSources), repoReads);
const openPullsCache = createOpenPullsCache(now);
const memberOpenPulls = createMemberOpenPulls({ cache: openPullsCache, ...credentialDeps, list: tenantOpenPrs, authorize: authorizePortal });
const policyFile = createPolicyFile({
  ...credentialDeps,
  settle: settleRepoPolicy,
  refusal: chosenFileRefusal,
  authorize: authorizePortal,
  tenantGithub,
  tenantBitbucket,
  openPulls: memberOpenPulls,
  changed: repoReads.changed,
  log: logJson,
});
const checkPackStore = { db: composition.db, artifacts: composition.db, automaticKinds: automation.automaticKinds, log: logJson };
function readStoredCheckPack(tenantId: string, repo: string) {
  return loadCheckPack(checkPackStore, tenantId, repo);
}
function settleRepoPolicy(tenantId: string, repo: string, source: RepoSource | undefined) {
  return settlePolicy({ ...checkPackStore, policyFile: policyFile.current }, tenantId, repo, source);
}
function chosenFileRefusal(tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>) {
  return fileRefusal({ ...checkPackStore, policyFile: policyFile.current }, tenantId, repo, source, policy);
}
async function readCheckPack(tenantId: string, repo: string, source: RepoSource | undefined) {
  return (await settleRepoPolicy(tenantId, repo, source)).read;
}
/** A push that lands a file matching the saved rules retires them now, so an edit after it is not taken for a difference. */
async function refreshPolicyFile(tenantId: string, repo: string, source: RepoSource) {
  const state = await policyFile.onPush(tenantId, repo, source);
  if (state) await settleRepoPolicy(tenantId, repo, source);
  return state;
}
// A tenant's system principal never changes once minted.
const githubSenderPrincipals = new Map<string, string>();
async function githubSenderPrincipal(tenantId: string): Promise<string> {
  const cached = githubSenderPrincipals.get(tenantId);
  if (cached !== undefined) return cached;
  await systemSender.resolve({ tenantId, domain: await tenantDomain(tenantId), localPart: GITHUB_SENDER });
  const row = await composition.db.query.principal.findFirst({
    where: and(eq(schema.principal.tenantId, tenantId), eq(schema.principal.kind, "user"), eq(schema.principal.refId, GITHUB_SENDER)),
  });
  if (!row) throw new Error(`no ${GITHUB_SENDER} system principal in tenant ${tenantId}`);
  githubSenderPrincipals.set(tenantId, row.id);
  return row.id;
}
function now(): Date {
  return new Date();
}
function reconcileTenants() {
  return composition.db.select({ id: schema.tenant.id, domain: schema.tenant.domain, config: schema.tenant.config }).from(schema.tenant);
}
const launchSpecs = createWorkflowRunLaunchSpecStore(composition.db);
async function liveTriageDeployments(tenantId: string, workflow: string) {
  return withWorkflowVersions(launchSpecs, await resolveLiveDeployments(composition.db, tenantId, workflow));
}
const tenantOpenHeads = createTenantOpenHeads(tenantSources);
const tenantOpenHead = createTenantOpenHead(tenantSources);
const tenantHeadChecks = createTenantHeadChecks(tenantSources);
const githubOpenPulls = createGithubOpenPulls({
  cache: openPullsCache,
  ...credentialDeps,
  list: tenantOpenPrs,
  authorize: authorizePortal,
});
const triageStateStore = createTriageStateStore({ db: composition.db, writerFor: githubSenderPrincipal, log: logJson });
const observeTriageRuns = createTriageRuns({
  runReader: composition.runReader,
  readSettled: createSettledStatusReader(composition.db),
  maxKnownRuns: TRIAGE_KNOWN_RUNS,
});
const tenantVersions = createTenantVersions();
const reconcilePolicy = triageReconcilePolicy(env);
const repoActivity = createRepoActivity(now, { quietMs: TRIAGE_RELIST_QUIET_MS, graceMs: TRIAGE_RELIST_GRACE_MS });
const runRecorder = createRunRecorder({ verdicts: verdictRecordStore, log: logJson });

/**
 * The observer and recording loop that copy verdicts into the verdict table from the run logs of one workflow's
 * listeners and of the workers of `workerIds`: a host's pr-triage reads its PR workflow variants' workers too, so their
 * runs settle its heads.
 */
function recordingStack(workflowId: string, workerIds: readonly string[] = [workflowId]) {
  function liveDeployments(tenantId: string) {
    return liveTriageDeployments(tenantId, workflowId);
  }
  async function workerDeployments(tenantId: string, endedSince: Date) {
    const workers = await Promise.all(workerIds.map((id) => recentWorkers(composition.db, tenantId, id, endedSince)));
    return withWorkflowVersions(launchSpecs, workers.flat());
  }
  async function activeTriageTenants(what: "runs" | "deployments", endedSince?: Date) {
    const active = await Promise.all([...new Set([workflowId, ...workerIds])].map((id) => activeTenants(composition.db, id, what, endedSince)));
    return [...new Map(active.flat().map((tenant) => [tenant.id, tenant])).values()];
  }
  const observer = createTenantObserver({
    liveDeployments,
    // Reconciler passes can be two intervals apart (a kick is skipped while one drains), and an observation is reused for a record interval.
    workers: { deployments: workerDeployments, endedWithinMs: 2 * triageReconcileIntervalMs(env) + 2 * TRIAGE_RECORD_MS },
    observeRuns: observeTriageRuns,
    recordRuns: runRecorder,
    versions: tenantVersions,
    minIntervalMs: TRIAGE_RECORD_MS,
    now,
  });
  const recordPass = createRecordPass({
    observer,
    activeTenants: activeTriageTenants,
    endedWithinMs: 2 * TRIAGE_RECORD_MS,
    backoffMs: TRIAGE_RECORD_MS,
    maxBackoffMs: TRIAGE_RECORD_MAX_BACKOFF_MS,
    now,
    log: logJson,
  });
  return { observer, recordPass, liveDeployments };
}

/** One host's observer, run recorder, rotation and reconciler over its own workflow's deployments. */
function triageStack(triage: TriageWorkflow) {
  const variants = PR_WORKFLOW_VARIANTS.filter((variant) => variant.source === triage.source).map((variant) => variant.id);
  const { observer, recordPass, liveDeployments } = recordingStack(triage.id, [triage.id, ...variants]);
  const rotation = createDeploymentRotation({
    db: composition.db,
    launchSpecs,
    allocation: composition.workflowAllocationService,
    lifecycle: composition.workflowLifecycleService,
    mayDeploy: function mayDeploy(principalId, tenantId) {
      return authorizePortal(principalId, tenantId, "workflow:*", "create");
    },
    rotationKey: triage.rotationKey,
  });
  const reconcile = createTriageReconciler({
    source: triage.source,
    rotationKey: triage.rotationKey,
    tenants: reconcileTenants,
    liveDeployments,
    headChecks: tenantHeadChecks,
    verdicts: verdictRecordStore,
    latestDeployments: function latestTriageDeployments(tenantId, limit) {
      return latestDeployments(composition.db, tenantId, triage.id, limit);
    },
    rotation: { afterRuns: triageRotateAfterRuns(env), ...rotation },
    openHeadsFor: tenantOpenHeads,
    activity: repoActivity,
    observeTenant: observer.observe,
    store: triageStateStore,
    readCheckPack,
    send: sendTriageMail,
    policy: reconcilePolicy,
    now,
    log: logJson,
  });
  return { triage, observer, recordPass, rotation, reconcile };
}

const stacks = TRIAGE_WORKFLOWS.map(triageStack);
// pr-triage-historical is only recorded: the reconcilers never mail or rotate it.
// A PR workflow variant's listener runs only the approvals of Dos its workers held; those workers are its host's stack's.
const recordings = [...stacks, recordingStack(prTriageHistoricalWorkflow.id), ...PR_WORKFLOW_VARIANTS.map((variant) => recordingStack(variant.id, []))];
// The portal's verdict listing reads every host's observations; connection changes use the GitHub stack's rotation to release.
const github = stacks.find((stack) => stack.triage.source === "github")!;
const deploymentRotation = github.rotation;
const tenantObserver = {
  last(tenantId: string) {
    const observations = recordings.flatMap((stack) => stack.observer.last(tenantId) ?? []);
    if (observations.length === 0) return undefined;
    return {
      deployments: observations.flatMap((observation) => observation.deployments),
      observed: observations.flatMap((observation) => observation.observed),
      workers: observations.flatMap((observation) => observation.workers),
    };
  },
};
function recordsReady(tenantId: string): boolean {
  return recordings.every((stack) => stack.recordPass.ready(tenantId));
}
async function recordAll() {
  for (const stack of recordings) await stack.recordPass.pass();
  return { retry: false };
}
async function reconcileAll(): Promise<ReconcileOutcome> {
  const outcomes: ReconcileOutcome[] = [];
  for (const stack of stacks) outcomes.push(await stack.reconcile());
  const retry = outcomes.some((outcome) => outcome.retry);
  const limits = outcomes.flatMap((outcome) => outcome.retryAt ?? []);
  return limits.length === 0 ? { retry } : { retry, retryAt: Math.min(...limits) };
}
recordLoop = createReconcileLoop(recordAll, { intervalMs: TRIAGE_RECORD_MS, retryMs: TRIAGE_RECORD_MS, retryMaxMs: TRIAGE_RECORD_MS }, logJson);
triageLoop = createReconcileLoop(reconcileAll, { intervalMs: triageReconcileIntervalMs(env), retryMs: TRIAGE_RETRY_MS, retryMaxMs: TRIAGE_RETRY_MAX_MS }, logJson);
const githubPrTriage = createGithubPrTriage({
  ...credentialDeps,
  authorize: authorizePortal,
  pullHead: async function pullHead(tenantId, record, number) {
    const openHead = await tenantOpenHead(tenantId);
    if (!openHead) throw new Error("no active source credential");
    return (await openHead(record, number))?.headSha;
  },
  readCheckPack,
  liveDeployments: liveTriageDeployments,
  observeRuns: observeTriageRuns,
  store: triageStateStore,
  send: sendTriageMail,
  policy: reconcilePolicy,
  now,
  log: logJson,
});
const githubHeldDos = createGithubHeldDos({
  ...credentialDeps,
  authorize: authorizePortal,
  runReader: composition.runReader,
  verdicts: verdictRecordStore,
  liveDeployments: liveTriageDeployments,
  deliver: deliverToDeployment,
  log: logJson,
});
const reconcileSourceDeployments = createSourceDeployments({
  connectedSources: function connectedSourcesOf(tenantId) {
    return connectedSources(composition.db, tenantId);
  },
  codeReviewSources: function codeReviewSourcesOf(tenantId) {
    return codeReviewSources(composition.db, tenantId);
  },
  codeReviewPlaced,
  liveDeployments: function liveOf(tenantId, workflow) {
    return resolveLiveDeployments(composition.db, tenantId, workflow);
  },
  release: deploymentRotation.release,
  log: logJson,
});
const kickTriage = triageLoop.kick;
async function onSourcesChanged(tenantId: string): Promise<void> {
  try {
    await reconcileSourceDeployments(tenantId);
  } catch (err) {
    logJson({ level: "error", msg: "triage_source_deployments_failed", tenantId, error: String(err) });
  }
  kickTriage();
}
const syncInstallations = createInstallationSync({
  ...credentialDeps,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
  onSynced: function installationsSynced(tenantId) {
    void renewGithubToken(tenantId);
    void onSourcesChanged(tenantId);
  },
});
function setTimer(fire: () => Promise<void>, ms: number): () => void {
  const handle = setTimeout(fire, ms);
  return function cancel() {
    clearTimeout(handle);
  };
}
/** A code review job keeps no state to fail: its head is forgotten, so the next event for it sends it again. */
async function failCoordinatedJob(job: TriageJob, error: string): Promise<void> {
  if (!triageWorkflowOf(job.workflow) && !prWorkflowVariantOf(job.workflow)) {
    codeReviewFeed.forget(job);
    logJson({ level: "error", msg: "code_review_failed", tenantId: job.tenantId, repo: job.repo, pr: job.number, headSha: job.headSha, error });
    return;
  }
  await failHead(triageStateStore, job, error, now());
}
await releaseOrphanedWorkers(composition.db, composition.workflowLifecycleService, logJson);
coordinator = createCoordinator({
  spawner: checkedBitbucketSpawner(createWorkerSpawner({
    db: composition.db,
    beforeDeploy: readyWorkerCredentials,
    redeploy: github.rotation.redeploy,
    deliver: deliverToDeployment,
    lifecycle: composition.workflowLifecycleService,
    sleep: Bun.sleep,
    fireTimeoutMs: WORKER_FIRE_TIMEOUT_MS,
    pollMs: WORKER_POLL_MS,
  }), tenantBitbucket),
  retry: { minMs: TRIAGE_RETRY_MS, maxMs: TRIAGE_RETRY_MAX_MS },
  failed: failCoordinatedJob,
  setTimer,
  now,
  log: logJson,
});
coalescer = createCoalescer({
  store: triageStateStore,
  sendMail: sendTriageMail,
  headChecks: tenantHeadChecks,
  openHeadFor: tenantOpenHead,
  window: triageCoalesceWindow(env, reconcilePolicy),
  ciWait: reconcilePolicy,
  setTimer,
  now,
  log: logJson,
});
async function recheckOpenPulls(tenantId: string, repo: string, except: number): Promise<number> {
  const due = await markBaseMoved(triageStateStore, tenantId, repo, except, now(), reconcilePolicy);
  if (due > 0) kickTriage();
  return due;
}
function sendBacklogMail(tenantId: string, payload: unknown) {
  return sendBridgeMail(tenantId, prTriageHistoricalWorkflow.id, payload);
}
const deliveryCache = new DeliveryCache({ filePath: `${env.HUB_DATA_DIR}/delivery-cache.json` });
const bridge = createBridgeHandler({
  db: hookDeps.db,
  cipher: hookDeps.cipher,
  cache: deliveryCache,
  coalescer,
  codeReview: codeReviewFeed,
  readCheckPack,
  openHeadFor: tenantOpenHead,
  recheckOpenPulls,
  refreshPolicyFile,
  heard: repoActivity.heard,
  startBacklog: createBacklogStart({ readCheckPack, sendMail: sendBacklogMail, log: logJson }),
  repoChanged: repoReads.changed,
});
const providerHooks = createProviderHookApp(createProviderHookHandler({
  db: hookDeps.db,
  cipher: hookDeps.cipher,
  cache: deliveryCache,
  coalescer,
  codeReview: codeReviewFeed,
  readCheckPack,
  recheckOpenPulls,
  refreshPolicyFile,
  heard: repoActivity.heard,
}));

function decodeSegments(rest: string): string[] | null {
  try {
    return rest.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
  } catch {
    return null;
  }
}

function hookTarget(req: Request, rest: string): { hookId: string; tenantHint?: string } | null {
  const url = new URL(req.url);
  const segments = decodeSegments(rest);
  // A path that is not percent-decodable is not a hook: answer 404 like stock
  // instead of throwing a 500 out of the fetch handler.
  if (segments === null) return null;
  if (segments.length === 0) {
    const hook = url.searchParams.get("hook") ?? req.headers.get("x-webhook-hook") ?? undefined;
    if (!hook) return null;
    return { hookId: hook, tenantHint: tenantHintFrom(req, undefined) };
  }
  if (segments.length === 1) {
    return { hookId: segments[0]!, tenantHint: tenantHintFrom(req, undefined) };
  }
  const [first, ...name] = segments as [string, ...string[]];
  return { hookId: name.join("/"), tenantHint: tenantHintFrom(req, first) };
}

function tenantHintFrom(req: Request, pathTenant: string | undefined): string | undefined {
  const url = new URL(req.url);
  const hint = pathTenant?.startsWith("tnt_") ? pathTenant : undefined;
  return hint ?? req.headers.get("x-tenant-id") ?? url.searchParams.get("tenant") ?? undefined;
}

const isHubOwner = createHubOwner(composition.db);
const integrations = createIntegrationsApp({ db: composition.db, getSession: composition.getSession, requireGrant, trustedPortalOrigins, log: logJson }, {
  authMethods: authMethods(signIn, smtp !== undefined),
  manifest: githubManifest,
  syncInstallations,
  connectGithubApp: createGithubAppConnection({ ...credentialDeps, authorize: authorizePortal, githubApiOrigin: githubOrigin, renewal: githubToken }),
  prActions: githubPrActions,
  heldDos: githubHeldDos,
  prTriage: githubPrTriage,
  policyRead: createGithubPolicyRead({ readCheckPack }),
  policyFileRead: policyFile.fileRoute,
  policyFileExport: policyFile.exportRoute,
  policyUpgrades: policyFile.upgradesRoute,
  backlog: createGithubBacklog({
    ...credentialDeps,
    authorize: authorizePortal,
    readCheckPack,
    sendMail: sendBacklogMail,
    log: logJson,
  }),
  openPulls: githubOpenPulls,
  prDetails: githubPrDetails,
  mergeStates,
  triageStats: createTriageStats({
    verdicts: verdictRecordStore,
    outcomes: createOutcomeReader({
      ...createHostReads({
        ...credentialDeps,
        artifacts: composition.db,
        githubApiOrigin: githubOrigin,
        tenantBitbucket,
        authorize: authorizePortal,
      }),
      now,
      log: logJson,
    }),
    now,
    log: logJson,
  }),
  triageTimeline: createTriageTimeline({ verdicts: verdictRecordStore }),
  triageVerdicts: createTriageVerdicts({
    ...credentialDeps,
    authorize: authorizePortal,
    verdicts: verdictRecordStore,
    observer: tenantObserver,
    ready: recordsReady,
    versions: tenantVersions,
    openPulls: openPullsCache,
    list: tenantOpenPrs,
    triageState: triageStateStore,
    now,
  }),
  audit: createAuditLog({
    db: composition.db,
    artifacts: composition.db,
    readCheckPack: readStoredCheckPack,
    runReader: composition.runReader,
    sameSource: deploymentRotation.sameSource,
    authorize: authorizePortal,
    workflows: [...TRIAGE_WORKFLOWS, ...PR_WORKFLOW_VARIANTS].map((workflow) => workflow.id),
  }),
  workflowDeploy: createWorkflowDeploy({ db: composition.db, allocation: composition.workflowAllocationService, onDeployed: onSourcesChanged }),
  workflowVersions: createWorkflowVersions({ db: composition.db, launchSpecs }),
  codeReview: createCodeReviewSwitch({ db: composition.db, authorize: authorizePortal, onChanged: onSourcesChanged, place: placeCodeReview, inPrWorkflow }),
  codeReviewPlace: createCodeReviewPlace({ authorize: authorizePortal, place: placeCodeReview, prWorkflowSources, probes: [...dockerPlaces(docker), { guide: E2B_PLACE, found: e2b }, { guide: RAILWAY_PLACE, found: railway }] }),
  codeReviewRun: createCodeReviewRun({ db: composition.db, authorize: authorizePortal, feed: codeReviewFeed, place: placeCodeReview, inPrWorkflow }),
  codeReviewLatest: codeReviewRuns.latestCodeReview,
  invitations: createInvitations({
    ...credentialDeps,
    authorize: authorizePortal,
    auth: composition.auth,
    stockFetch: async function stockFetch(req) {
      return composition.app.fetch(req);
    },
    allowedEmails: signIn.allowedEmails,
    linkOrigin: inviteLinkOrigin(env),
    sendEmail: smtp?.invite,
    isHubOwner,
    now,
    log: logJson,
  }),
  bitbucketDatacenter: createBitbucketIntegration({
    ...credentialDeps,
    authorize: authorizePortal,
    stockFetch: async function stockFetch(req) {
      return composition.app.fetch(req);
    },
    publicOrigin: new URL(env.BETTER_AUTH_BASE_URL).origin,
    fetchImpl: fetch,
    egressAllowlist: bitbucketEgressAllowlist(env),
    onEnabled: triageLoop.kick,
    onConnectionChanged: onSourcesChanged,
    now,
    log: logJson,
  }),
  sessions: createSessions(composition.db),
});
// Mounted so the stock /openapi.json lists the routes; requests reach them
// through routeRequest before the stock logger.
composition.app.route("/", integrations);
composition.app.route("/", providerHooks);

const refuseUnverified = createVerifiedGate({ isHubOwner, getSession: composition.getSession, allowedEmails: signIn.allowedEmails });
const servePortal = env.PORTAL_DIR === undefined ? undefined : createPortalHandler(env.PORTAL_DIR);

/** A stock credential write: App JSON it leaves in `github` is moved to the hub and taken back from sidecars at once. */
const CREDENTIAL_WRITE = /^\/api\/tenants\/([^/]+)\/credentials(?:\/([^/]+))?$/;

function decodedSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function routeRequest(req: Request, server: Parameters<typeof stock.fetch>[1]): Promise<Response> {
  if (servePortal && isPortalRequest(req)) return servePortal(req);
  const url = new URL(req.url);
  if (url.pathname === HOOK_MOUNT_PATH || url.pathname.startsWith(`${HOOK_MOUNT_PATH}/`)) {
    // Fail fast on bodies the stock hook app would reject with 413, before
    // hook lookup, decrypt or HMAC work. The bridge re-checks actual bytes
    // while reading (Content-Length may be missing or dishonest).
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (isProviderHookPath(url.pathname)) return providerHooks.fetch(req);
    if (req.headers.get("x-hub-signature-256") !== null) {
      const rest = url.pathname.slice(HOOK_MOUNT_PATH.length);
      const target = hookTarget(req, rest);
      if (!target) return Response.json({ error: "unknown_hook" }, { status: 404 });
      return bridge(req, target);
    }
    const rest = url.pathname.slice(HOOK_MOUNT_PATH.length);
    if (decodeSegments(rest) === null) return Response.json({ error: "unknown_hook" }, { status: 404 });
    const target = new URL(req.url);
    target.pathname = rest === "" || rest === "/" ? "/" : rest;
    return hookApp.fetch(new Request(target.href, req));
  }
  const unverified = await refuseUnverified(req);
  if (unverified) return unverified;
  // Intercept before the stock Hono logger: callback query values include the
  // one-time GitHub code and must never enter request/access logs.
  if (url.pathname.startsWith(INTEGRATIONS_PREFIX)) return integrations.fetch(req);
  if (req.method === "PATCH") {
    const tenantMatch = /^\/api\/tenants\/([^/]+)$/.exec(url.pathname);
    if (tenantMatch) {
      let tenantId = tenantMatch[1]!;
      try {
        tenantId = decodeURIComponent(tenantId);
      } catch {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const principalId = await tenantManager({ db: composition.db, getSession: composition.getSession, authorize: authorizePortal }, tenantId, req.headers);
      if (principalId instanceof Response) return principalId;
      const prepared = await prepareCorbitsTriagePatch({
        db: composition.db,
        authorize: authorizePortal,
        grantEnabled(tx, repo) {
          return grantEnabledKinds(tx, tenantId, repo, "github", now());
        },
      }, tenantId, principalId, req);
      if (prepared instanceof Response) return prepared;
      return stock.fetch(prepared, server);
    }
  }
  const written = req.method === "POST" || req.method === "PATCH" ? CREDENTIAL_WRITE.exec(url.pathname) : null;
  const writtenTenant = written ? decodedSegment(written[1]!) : undefined;
  if (writtenTenant === undefined) return stock.fetch(req, server);
  const refused = await appKeyWriteRefusal(composition.db, writtenTenant, written?.[2] === undefined ? undefined : decodedSegment(written[2]), req);
  if (refused) return refused;
  const response = await stock.fetch(req, server);
  // A backstop for App JSON a write still leaves in `github`.
  if (response.ok) await githubToken.secure(writtenTenant);
  return response;
}

triageLoop.start();
recordLoop.start();
tokenLoop.start();

logJson({
  level: "info",
  msg: "hub_composition",
  deployments: EXPECTED_DEPLOYMENT_SET,
  webhookMount: HOOK_MOUNT_PATH,
});

export default {
  ...stock,
  development: false,
  fetch: env.PORTAL_ORIGIN === undefined ? routeRequest : withPortalCors(new URL(env.PORTAL_ORIGIN).origin, routeRequest),
};
