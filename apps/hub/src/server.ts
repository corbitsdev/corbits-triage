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
import { TRIAGE_MAIL_SENDER } from "@corbits/triage-contracts";
import { createArtifactGrants, grantAdminsPolicyWrites } from "./artifact-grants.js";
import { createInterchangeHub } from "./interchange-hub.js";
import { createLocalProcessSidecarProvisioner } from "./sidecar/local-provisioner.js";
import { createLocalSidecarManifestStore } from "./sidecar/manifest-store.js";
import { restoreLocalSidecars } from "./sidecar/restore.js";
import { createSpawnLocalSidecar } from "./sidecar/spawn.js";
import { buildSidecarAdapterManifest } from "./sidecar-config.js";
import { createPortalHandler, isPortalRequest, withPortalCors } from "./portal.js";
import { createInstallationSync } from "./github/installation-sync.js";
import { authMethods } from "./auth.js";
import { createIntegrationsApp, INTEGRATIONS_PREFIX } from "./integrations/app.js";
import { createBitbucketIntegration } from "./bitbucket-datacenter/integration.js";
import { createTenantBitbucket } from "./bitbucket-datacenter/tenant-bitbucket.js";
import { codeReviewSources, codeReviewWorkflowFor, connectedSources, createSourceDeployments, TRIAGE_WORKFLOWS, triageWorkflowFor, triageWorkflowOf, type TriageWorkflow } from "./github/source-workflow.js";
import { createInvitations } from "./invitations/invitations.js";
import { createSmtpEmail } from "./invitations/invite-email.js";
import { createWorkflowDeploy } from "./workflow-deploy.js";
import { createCodeReviewSwitch } from "./code-review.js";
import { createWorkflowVersions } from "./workflow-versions.js";
import { childProcessEnv, databaseConfig, emailSettings, interchangeSettings, githubApiOrigin, loadHubEnv, migrationEnv, inviteLinkOrigin, signInSettings, triageBatchSize, triageCoalesceWindow, triageCoordinator, triageReconcileIntervalMs, triageReconcilePolicy, triageRotateAfterRuns } from "./env.js";
import { HOOK_MOUNT_PATH, createStockHookApp, migrateWebhooks } from "./hooks.js";
import { createBridgeHandler, logJson } from "./github/bridge.js";
import { createProviderHookApp, isProviderHookPath } from "./provider-hooks/app.js";
import { createProviderHookHandler } from "./provider-hooks/intake.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { createCoalescer, type Coalescer } from "./github/coalescer.js";
import { createCoordinator, type Coordinator, type TriageJob } from "./github/coordinator.js";
import { createTriageQueueView } from "./github/triage-queue-view.js";
import { createWorkerSpawner, releaseOrphanedWorkers } from "./github/worker-spawn.js";
import { DeliveryCache } from "./github/dedupe.js";
import { activeTenants, createDeploymentRotation, latestDeployments, NoLiveDeploymentError, readyMaterializer, recentWorkers, resolveLiveDeployment, resolveLiveDeployments, withWorkflowVersions } from "./github/deployment.js";
import { createGithubOpenPulls, createOpenPullsCache } from "./github/open-pulls.js";
import { createGithubPrActions } from "./github/pr-actions.js";
import { createGithubHeldDos } from "./github/held-dos.js";
import { createVerdictRecordStore } from "./github/verdict-record-store.js";
import { createSessions } from "./sessions.js";
import { migrateTriageTables } from "./triage-db.js";
import { createTriageStats } from "./github/triage-stats.js";
import { createHostReads, createOutcomeReader } from "./github/pr-outcomes.js";
import { createTriageTimeline } from "./github/triage-timeline.js";
import { createAuditLog } from "./audit-log.js";
import { createRunRecorder } from "./github/run-recorder.js";
import { createRecordPass, createTenantObserver, createTenantVersions } from "./github/tenant-observer.js";
import { createTriageVerdicts } from "./github/triage-verdicts.js";
import { createGithubPrDetails } from "./github/pr-details.js";
import { createGithubPrPreview } from "./github/pr-preview.js";
import { createGithubPrTriage } from "./github/pr-triage.js";
import { createPolicyFile } from "./github/policy-file.js";
import { createGithubPolicyRead } from "./github/policy-read.js";
import { createGithubBacklog } from "./github/backlog-triage.js";
import { loadCheckPack } from "./github/check-pack-store.js";
import { createAutomation, grantEnabledKinds } from "./github/automation.js";
import { createReconcileLoop } from "./github/reconcile-loop.js";
import { createTriageReconciler } from "./github/triage-reconciler.js";
import { createTenantGithub, createTenantHeadChecks, createTenantOpenHead, createTenantOpenHeads, createTenantOpenPrs } from "./github/tenant-open-heads.js";
import { createSettledStatusReader, createTriageRuns } from "./github/triage-runs.js";
import { createTriageStateStore } from "./github/triage-state-store.js";
import { failHead, markBaseMoved } from "./github/triage-queue.js";
import { createGithubManifestIntegration } from "./github/manifest.js";
import { migrateRepoEnabledFlag, prepareCorbitsTriagePatch, tenantManagerRefusal } from "./github/tenant-config.js";
import { workflow as prTriageGithub } from "@corbits/triage-workflows/pr-triage-github";
import { PR_TRIAGE_HISTORICAL_ADDRESS, workflow as prTriageHistoricalWorkflow } from "@corbits/triage-workflows/pr-triage-historical";
import { githubRead, githubWrite } from "@corbits/github-tool";
import { bitbucketRead, bitbucketWrite } from "@corbits/bitbucket-datacenter-tool";

// Per host: a workspace deploys a host's workflow and tools once that host's credential exists; pr-triage-historical
// reads GitHub only. A workspace with both hosts runs both pr-triage workflows. A host's code review deploys while a
// repository of it has code review on.
const EXPECTED_DEPLOYMENT_SET = {
  github: {
    workflows: [
      { address: triageWorkflowFor("github").address, id: prTriageGithub.id },
      { address: PR_TRIAGE_HISTORICAL_ADDRESS, id: prTriageHistoricalWorkflow.id },
      { address: codeReviewWorkflowFor("github").id, id: codeReviewWorkflowFor("github").id },
    ],
    tools: [githubRead.id, githubWrite.id],
  },
  "bitbucket-datacenter": {
    workflows: [
      { address: triageWorkflowFor("bitbucket-datacenter").address, id: triageWorkflowFor("bitbucket-datacenter").id },
      { address: codeReviewWorkflowFor("bitbucket-datacenter").id, id: codeReviewWorkflowFor("bitbucket-datacenter").id },
    ],
    tools: [bitbucketRead.id, bitbucketWrite.id],
  },
};

// Runs whose trigger and outcome the reconciler remembers between passes.
const TRIAGE_KNOWN_RUNS = 10_000;
const TRIAGE_RETRY_MS = 15_000;
const TRIAGE_RETRY_MAX_MS = 120_000;
/** How often the live logs of tenants with a pr-triage run in flight are read and recorded, and how stale a shared read may be. */
const TRIAGE_RECORD_MS = 2_000;
const WORKER_FIRE_TIMEOUT_MS = 120_000;
const WORKER_POLL_MS = 2_000;
/** A tenant whose logs could not be read is left at most this long before the recording loop tries again. */
const TRIAGE_RECORD_MAX_BACKOFF_MS = 5 * 60_000;

const ROOT = resolve(import.meta.dir, "../../..");
const V = resolve(ROOT, "vendor/interchange");
const env = loadHubEnv(process.env);
const database = databaseConfig(env);
const githubOrigin = githubApiOrigin(env);
const sidecarAdapterManifest = buildSidecarAdapterManifest(env.HUB_DATA_DIR, githubOrigin);

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
  adapterManifest: sidecarAdapterManifest,
  log: logJson,
});

let shuttingDown = false;
let cronTicker: CronTicker | undefined;
let triageLoop: ReturnType<typeof createReconcileLoop> | undefined;
let recordLoop: ReturnType<typeof createReconcileLoop> | undefined;
let coalescer: Coalescer | undefined;
let coordinator: Coordinator | undefined;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  cronTicker?.stop();
  triageLoop?.stop();
  recordLoop?.stop();
  coalescer?.stop();
  coordinator?.stop();
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
  authConfig: { ...signIn, baseURL: env.BETTER_AUTH_BASE_URL, secret: env.BETTER_AUTH_SECRET, trustedOrigins: portalOrigin, portalOrigin: inviteLinkOrigin(env), ...(smtp && { sendResetPassword: smtp.passwordReset }) },
  credentialCipher,
  adapterManifest: sidecarAdapterManifest,
  sidecarProvisioners: [local.provisioner],
  probeSidecarProvisioners: [local.provisioner],
});
const stock = composition.server;

await restoreLocalSidecars(composition.db, local);
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
  db: composition.db,
  cipher: composition.credentialCipher,
  getSession: composition.getSession,
  trustedPortalOrigins,
  githubApiOrigin: githubOrigin,
  publicOrigin: new URL(env.BETTER_AUTH_BASE_URL).origin,
  authorizeCredential: authorizePortal,
  stateSecret: env.BETTER_AUTH_SECRET,
});
const githubPrActions = createGithubPrActions({
  db: composition.db,
  cipher: composition.credentialCipher,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
  readCheckPack,
  log: logJson,
});
const tenantBitbucket = createTenantBitbucket({ db: composition.db, cipher: composition.credentialCipher, fetchImpl: fetch });
const githubPrDetails = createGithubPrDetails({
  db: composition.db,
  cipher: composition.credentialCipher,
  githubApiOrigin: githubOrigin,
  tenantBitbucket,
  authorize: authorizePortal,
  log: logJson,
});

const hookDeps = { db: composition.db, cipher: composition.credentialCipher };
const hookApp = createStockHookApp(
  hookDeps,
  composition.principalKeyStore,
  composition.sidecarRouter,
);

const GITHUB_SENDER = TRIAGE_MAIL_SENDER;
const githubDeliverer = runTriggerDeliverer(GITHUB_SENDER);
async function deliverToDeployment(tenantId: string, address: string, payload: unknown): Promise<void> {
  await githubDeliverer.to(address, JSON.stringify(payload), tenantId, undefined);
}
/** A hook credential written before hosts names `pr-triage`; its mail goes to the GitHub workflow that replaced it. */
async function sendBridgeMail(tenantId: string, workflow: string, payload: unknown): Promise<void> {
  const id = triageWorkflowOf(workflow)?.id ?? workflow;
  const live = await resolveLiveDeployment(composition.db, tenantId, id);
  if (!live) throw new NoLiveDeploymentError(id);
  await deliverToDeployment(tenantId, live.address, payload);
}
const coordination = triageCoordinator(env);
/** The workflow a job's worker is seeded from: a host's triage workflow, by either name it goes by. */
function workflowIdFor(name: string): string {
  const triage = triageWorkflowOf(name);
  if (!triage) throw new Error(`Not a triage workflow: ${name}`);
  return triage.id;
}
/** Every triage mail, whatever started it, goes out through here: to the live listener, or with the coordinator on, to a worker of its own. */
async function sendTriageMail(job: TriageJob): Promise<void> {
  if (coordinator) return coordinator.enqueue({ ...job, workflow: workflowIdFor(job.workflow) });
  if (job.address === undefined) return sendBridgeMail(job.tenantId, job.workflow, job.payload);
  await deliverToDeployment(job.tenantId, job.address, job.payload);
}
function readCheckPack(tenantId: string, repo: string) {
  return loadCheckPack({ db: composition.db, artifacts: composition.db, automaticKinds: automation.automaticKinds, log: logJson }, tenantId, repo);
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
const tenantSources = { db: composition.db, cipher: composition.credentialCipher, githubApiOrigin: githubOrigin, tenantBitbucket };
const tenantOpenHeads = createTenantOpenHeads(tenantSources);
const tenantOpenHead = createTenantOpenHead(tenantSources);
const tenantOpenPrs = createTenantOpenPrs(tenantSources);
const tenantHeadChecks = createTenantHeadChecks(tenantSources);
const openPullsCache = createOpenPullsCache(now);
const githubOpenPulls = createGithubOpenPulls({
  cache: openPullsCache,
  db: composition.db,
  cipher: composition.credentialCipher,
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
const runRecorder = createRunRecorder({ verdicts: verdictRecordStore, log: logJson });

/** The observer and recording loop that copy one workflow's verdicts from its deployments' run logs into the verdict table. */
function recordingStack(workflowId: string) {
  function liveDeployments(tenantId: string) {
    return liveTriageDeployments(tenantId, workflowId);
  }
  async function workerDeployments(tenantId: string, endedSince: Date) {
    return withWorkflowVersions(launchSpecs, await recentWorkers(composition.db, tenantId, workflowId, endedSince));
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
    activeTenants: function activeTriageTenants(what, endedSince) {
      return activeTenants(composition.db, workflowId, what, endedSince);
    },
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
  const { observer, recordPass, liveDeployments } = recordingStack(triage.id);
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
    observeTenant: observer.observe,
    store: triageStateStore,
    readCheckPack,
    send: sendTriageMail,
    policy: reconcilePolicy,
    batchSize: triageBatchSize(env),
    batched: !coordination.enabled,
    now,
    log: logJson,
  });
  return { triage, observer, recordPass, rotation, reconcile };
}

const stacks = TRIAGE_WORKFLOWS.map(triageStack);
// pr-triage-historical is only recorded: the reconcilers never mail or rotate it.
const recordings = [...stacks, recordingStack(prTriageHistoricalWorkflow.id)];
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
async function reconcileAll() {
  let retry = false;
  for (const stack of stacks) if ((await stack.reconcile()).retry) retry = true;
  return { retry };
}
recordLoop = createReconcileLoop(recordAll, { intervalMs: TRIAGE_RECORD_MS, retryMs: TRIAGE_RECORD_MS, retryMaxMs: TRIAGE_RECORD_MS }, logJson);
triageLoop = createReconcileLoop(reconcileAll, { intervalMs: triageReconcileIntervalMs(env), retryMs: TRIAGE_RETRY_MS, retryMaxMs: TRIAGE_RETRY_MAX_MS }, logJson);
const githubPrTriage = createGithubPrTriage({
  db: composition.db,
  cipher: composition.credentialCipher,
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
  db: composition.db,
  cipher: composition.credentialCipher,
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
  db: composition.db,
  cipher: composition.credentialCipher,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
  onSynced: function installationsSynced(tenantId) {
    void onSourcesChanged(tenantId);
  },
});
function setTimer(fire: () => Promise<void>, ms: number): () => void {
  const handle = setTimeout(fire, ms);
  return function cancel() {
    clearTimeout(handle);
  };
}
function failTriageHead(job: TriageJob, error: string): Promise<void> {
  return failHead(triageStateStore, job, error, now());
}
if (coordination.enabled) {
  await releaseOrphanedWorkers(composition.db, composition.workflowLifecycleService, logJson);
  const triageCoordination = createCoordinator({
    spawner: createWorkerSpawner({
      db: composition.db,
      redeploy: github.rotation.redeploy,
      deliver: deliverToDeployment,
      lifecycle: composition.workflowLifecycleService,
      sleep: Bun.sleep,
      fireTimeoutMs: WORKER_FIRE_TIMEOUT_MS,
      pollMs: WORKER_POLL_MS,
    }),
    limits: coordination.limits,
    retry: { minMs: TRIAGE_RETRY_MS, maxMs: TRIAGE_RETRY_MAX_MS },
    failed: failTriageHead,
    setTimer,
    now,
    log: logJson,
  });
  coordinator = triageCoordination;
}
coalescer = createCoalescer({
  store: triageStateStore,
  sendMail: sendTriageMail,
  headChecks: tenantHeadChecks,
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
const policyFile = createPolicyFile({
  db: composition.db,
  artifacts: composition.db,
  cipher: composition.credentialCipher,
  authorize: authorizePortal,
  tenantGithub: createTenantGithub({ db: composition.db, cipher: composition.credentialCipher, githubApiOrigin: githubOrigin }),
  tenantBitbucket,
  writerFor: githubSenderPrincipal,
  grantWriters: createArtifactGrants(now),
  now,
  log: logJson,
});
const deliveryCache = new DeliveryCache({ filePath: `${env.HUB_DATA_DIR}/delivery-cache.json` });
const bridge = createBridgeHandler({
  db: hookDeps.db,
  cipher: hookDeps.cipher,
  cache: deliveryCache,
  coalescer,
  readCheckPack,
  openHeadFor: tenantOpenHead,
  recheckOpenPulls,
  syncPolicyFile: policyFile.onPush,
});
const providerHooks = createProviderHookApp(createProviderHookHandler({
  db: hookDeps.db,
  cipher: hookDeps.cipher,
  cache: deliveryCache,
  coalescer,
  readCheckPack,
  recheckOpenPulls,
  syncPolicyFile: policyFile.onPush,
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

const integrations = createIntegrationsApp({ db: composition.db, getSession: composition.getSession, requireGrant, trustedPortalOrigins, log: logJson }, {
  authMethods: authMethods(signIn, smtp !== undefined),
  manifest: githubManifest,
  syncInstallations,
  prActions: githubPrActions,
  heldDos: githubHeldDos,
  prTriage: githubPrTriage,
  policyRead: createGithubPolicyRead({ readCheckPack }),
  policyFileRead: policyFile.fileRoute,
  policyFileSync: policyFile.syncRoute,
  policyFileExport: policyFile.exportRoute,
  backlog: createGithubBacklog({
    db: composition.db,
    cipher: composition.credentialCipher,
    authorize: authorizePortal,
    readCheckPack,
    sendMail: function sendBacklogMail(tenantId, payload) {
      return sendBridgeMail(tenantId, prTriageHistoricalWorkflow.id, payload);
    },
    log: logJson,
  }),
  openPulls: githubOpenPulls,
  prDetails: githubPrDetails,
  prPreview: createGithubPrPreview({
    db: composition.db,
    cipher: composition.credentialCipher,
    githubApiOrigin: githubOrigin,
    authorize: authorizePortal,
    readCheckPack,
  }),
  triageStats: createTriageStats({
    verdicts: verdictRecordStore,
    outcomes: createOutcomeReader({
      ...createHostReads({
        db: composition.db,
        artifacts: composition.db,
        cipher: composition.credentialCipher,
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
  triageQueue: createTriageQueueView({ coordinator, now }),
  triageVerdicts: createTriageVerdicts({
    db: composition.db,
    cipher: composition.credentialCipher,
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
    readCheckPack,
    runReader: composition.runReader,
    sameSource: deploymentRotation.sameSource,
    authorize: authorizePortal,
    workflows: TRIAGE_WORKFLOWS.map((workflow) => workflow.id),
  }),
  workflowDeploy: createWorkflowDeploy({ db: composition.db, allocation: composition.workflowAllocationService, onDeployed: onSourcesChanged }),
  workflowVersions: createWorkflowVersions({ db: composition.db, launchSpecs }),
  codeReview: createCodeReviewSwitch({ db: composition.db, authorize: authorizePortal, onChanged: onSourcesChanged }),
  invitations: createInvitations({
    db: composition.db,
    cipher: composition.credentialCipher,
    authorize: authorizePortal,
    auth: composition.auth,
    stockFetch: async function stockFetch(req) {
      return composition.app.fetch(req);
    },
    allowedEmails: signIn.allowedEmails,
    linkOrigin: inviteLinkOrigin(env),
    sendEmail: smtp?.invite,
    now,
    log: logJson,
  }),
  bitbucketDatacenter: createBitbucketIntegration({
    db: composition.db,
    cipher: composition.credentialCipher,
    authorize: authorizePortal,
    stockFetch: async function stockFetch(req) {
      return composition.app.fetch(req);
    },
    publicOrigin: new URL(env.BETTER_AUTH_BASE_URL).origin,
    fetchImpl: fetch,
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

const servePortal = env.PORTAL_DIR === undefined ? undefined : createPortalHandler(env.PORTAL_DIR);

async function routeRequest(req: Request, server: Parameters<typeof stock.fetch>[1]): Promise<Response> {
  if (servePortal && isPortalRequest(req)) return servePortal(req);
  const url = new URL(req.url);
  // Intercept before the stock Hono logger: callback query values include the
  // one-time GitHub code and must never enter request/access logs.
  if (url.pathname.startsWith(INTEGRATIONS_PREFIX)) return integrations.fetch(req);
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
  if (req.method === "PATCH") {
    const tenantMatch = /^\/api\/tenants\/([^/]+)$/.exec(url.pathname);
    if (tenantMatch) {
      let tenantId = tenantMatch[1]!;
      try {
        tenantId = decodeURIComponent(tenantId);
      } catch {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      const refused = await tenantManagerRefusal({ db: composition.db, getSession: composition.getSession, authorize: authorizePortal }, tenantId, req.headers);
      if (refused) return refused;
      const prepared = await prepareCorbitsTriagePatch(composition.db, tenantId, req, function grantEnabled(tx, repo) {
        return grantEnabledKinds(tx, tenantId, repo, "github", now());
      });
      if (prepared instanceof Response) return prepared;
      return stock.fetch(prepared, server);
    }
  }
  return stock.fetch(req, server);
}

triageLoop.start();
recordLoop.start();

logJson({
  level: "info",
  msg: "hub_composition",
  deployments: EXPECTED_DEPLOYMENT_SET,
  webhookMount: HOOK_MOUNT_PATH,
});

export default {
  ...stock,
  fetch: env.PORTAL_ORIGIN === undefined ? routeRequest : withPortalCors(new URL(env.PORTAL_ORIGIN).origin, routeRequest),
};
