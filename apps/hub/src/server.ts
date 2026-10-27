// Composition over the stock Interchange hub bootstrap (./interchange-hub.ts).
// GitHub manifest start/callback and PR actions are custom domain routes
// because GitHub must return a one-time code to a confidential server before
// any browser can observe it. GitHub-signed hook requests go to the legacy
// bridge until upstream ships a GitHub verifier; other source hosts post to
// /api/hooks/:provider/:tenantId (./provider-hooks). Every other /api/* path falls
// through to stock unchanged.
//
// createHubServer takes no workflow/tool registry: the hub publishes the
// triage workflows the portal build bundles and deploys them per tenant
// (./workflow-release), and the bridge finds them by name.
// EXPECTED_DEPLOYMENT_SET is that contract, referenced (not stringly typed) so
// a workflow rename or tool-id change breaks the build here.
import { resolve } from "node:path";
import { authorize } from "@intx/authz";
import { createGrantStore, createWorkflowRunLaunchSpecStore, resolveSenderPrincipal, schema, type DB, type ResolvedSenderPrincipal } from "@intx/db";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { hexDecode } from "@intx/types";
import { generateId } from "@intx/hub-common";
import { eq } from "drizzle-orm";
import { getPath } from "hono/utils/url";
import { createMailTriggeredRunGrantsMaterializer, createRequireGrant, HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import {
  createRunTriggerDeliverer,
  createTenantSystemSender,
  type MailDeliverer,
} from "@corbits/webhooks";
import {
  createCronTicker,
  createRunTriggerCronDeliver,
  type CronTicker,
} from "@corbits/cron";
import { E2B_PLACE } from "@corbits/provisioner-e2b";
import { RAILWAY_PLACE } from "@corbits/provisioner-railway";
import { REPO_SOURCES, repoSourceOf, TRIAGE_LISTENERS, TRIAGE_MAIL_SENDER, TRIAGE_MANAGERS, type RepoSource } from "@corbits/triage-contracts";
import { asRecord, errorText } from "@corbits/common";
import { createInterchangeHub } from "./interchange-hub.js";
import { createManagerIntake, createManagerWake, createOverdueWake, createSupersede } from "./manager-intake.js";
import { MANAGER_RUN_TOKEN_ROUTES } from "./manager-routes.js";
import { deploymentUp, endNeverRan, liveListener, notePlaced, passRequest } from "./manager-state.js";
import { mountTenantRoutes } from "./tenant-routes.js";
import { connectDockerSidecars, dockerPlaces, sweepDockerSidecarsOf } from "./sidecar/docker.js";
import { connectE2bSidecars, tendE2bSidecarsOf, type E2bSidecarProvisioner } from "./sidecar/e2b.js";
import { createLocalProcessSidecarProvisioner } from "./sidecar/local-provisioner.js";
import { connectRailwaySidecars, sweepRailwaySidecarsOf, type RailwaySidecarProvisioner } from "./sidecar/railway.js";
import { createHostCapacity } from "./sidecar/host-capacity.js";
import { createLocalSidecarManifestStore } from "./sidecar/manifest-store.js";
import { createPlacementChooser, localSidecarUsage } from "./sidecar/placement.js";
import { restoreLocalSidecars } from "./sidecar/restore.js";
import { createSpawnLocalSidecar } from "./sidecar/spawn.js";
import { SIDECAR_ADAPTER_MANIFEST } from "./sidecar-config.js";
import { createPortalHandler, isPortalRequest, withPortalCors } from "./portal.js";
import { createInstallationSync } from "./github/installation-sync.js";
import { authMethods } from "./auth.js";
import { createIntegrationsApp, INTEGRATIONS_PREFIX, logRefusal } from "./integrations/app.js";
import { createBitbucketCodeReviewSend } from "./bitbucket-datacenter/code-review-send.js";
import { createBitbucketIntegration } from "./bitbucket-datacenter/integration.js";
import { checkedBitbucketDelivery, createTenantBitbucket } from "./bitbucket-datacenter/tenant-bitbucket.js";
import { createPauseGate } from "./github/pr-workflow.js";
import { APPROVAL_WORKFLOWS, connectedSources, createHostRelease } from "./github/source-workflow.js";
import { createInvitations } from "./invitations/invitations.js";
import { createSmtpEmail } from "./invitations/invite-email.js";
import { createCodeReviewPlace, createCodeReviewPlacement, createCodeReviewRun, isolatedPlaceBootWarning } from "./code-review.js";
import { createPullRequestReader } from "./pull-request-reader.js";
import { createCodeReviewRuns } from "./code-review-runs.js";
import { createWorkflowVersions } from "./workflow-versions.js";
import { triageTenants } from "./deployer-role.js";
import { bundleAt, bundled, type Publisher } from "./workflow-release/publish.js";
import { createListenerWatch, releaseWriteOf } from "./workflow-release/triggers.js";
import { setUpPublisher, TRIAGE_PUBLISHER } from "./workflow-release/publisher.js";
import { catalogModels, createWorkspaceLock, deployedAllocation, deploymentState, liveDeployments } from "./workflow-release/reads.js";
import { createRolloutQueue, createWorkflowRollout, stopGivenUp, type DeployRequest } from "./workflow-release/rollout.js";
import { bitbucketEgressAllowlist, childProcessEnv, clientIpHeaders, databaseConfig, dockerSettings, e2bSettings, emailSettings, interchangeSettings, githubApiOrigin, loadHubEnv, inviteLinkOrigin, localSidecarMaxDeployments, railwaySandboxSettings, signInSettings, triageCoalesceWindow, triageReconcileIntervalMs, triageReconcilePolicy } from "./env.js";
import { HOOK_MOUNT_PATH } from "./hooks.js";
import { assertMigrated } from "./migrations.js";
import { createBridgeHandler, logJson, withAppLogin } from "./github/bridge.js";
import { createGithubTokenRenewal, GITHUB_TOKEN_RENEW_MS } from "./github/installation-token.js";
import { appKeyProviderWriteRefusal, appKeyWriteRefusal, githubTenants, moveAppKey } from "./github/app-key.js";
import { createGithubAppConnection } from "./github/app-connection.js";
import { createProviderHookApp, isProviderHookPath } from "./provider-hooks/app.js";
import { createProviderHookHandler } from "./provider-hooks/intake.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { createCoalescer, type Coalescer } from "./github/coalescer.js";
import { DeliveryCache } from "./github/dedupe.js";
import { readyMaterializer, systemSenderMaterializer, resolveLiveDeployments, TriageStoppedError, type LiveDeployment } from "./github/deployment.js";
import { createGithubOpenPulls, createMemberOpenPulls, createOpenPullsCache, keptOpenPrs } from "./github/open-pulls.js";
import { createRepoReads } from "./github/repo-reads.js";
import { createGithubPrActions } from "./github/pr-actions.js";
import { createGithubHeldDos } from "./github/held-dos.js";
import { createVerdictRecordStore } from "./github/verdict-record-store.js";
import { createManagerRuns } from "./github/manager-runs.js";
import { createSessions } from "./sessions.js";
import { createVerifiedGate } from "./verified-gate.js";
import { createHubOwner } from "./hub-owner.js";
import { createTriageStats } from "./github/triage-stats.js";
import { createHostReads, createOutcomeReader } from "./github/pr-outcomes.js";
import { createTriageTimeline } from "./github/triage-timeline.js";
import { createAuditLog } from "./audit-log.js";
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
import { createTriageStateStore } from "./github/triage-state-store.js";
import { markBaseMoved, type TriageJob } from "./github/triage-queue.js";
import { createGithubManifestIntegration } from "./github/manifest.js";
import { prepareCorbitsTriagePatch, tenantManager } from "./github/tenant-config.js";
import { githubRead } from "@corbits/github-tool";
import { bitbucketRead } from "@corbits/bitbucket-datacenter-tool";

// Per host: the hub deploys the host's listener and tools once that host's credential exists, and the listener deploys
// a manager per pull request. A workspace with both hosts runs both listeners.
function hostWorkflows(source: RepoSource) {
  return [TRIAGE_LISTENERS[source], TRIAGE_MANAGERS[source]].map((id) => ({ address: id, id }));
}
const EXPECTED_DEPLOYMENT_SET = {
  github: { workflows: hostWorkflows("github"), tools: [githubRead.id] },
  "bitbucket-datacenter": { workflows: hostWorkflows("bitbucket-datacenter"), tools: [bitbucketRead.id] },
};

const TRIAGE_RETRY_MS = 15_000;
const TRIAGE_RETRY_MAX_MS = 120_000;
/** A repository is listed again once its listing is this old, and every pass once its webhook (the App's, on GitHub) heard nothing this long. */
const TRIAGE_RELIST_QUIET_MS = 30 * 60_000;
/** A listing that started this soon after a repository's webhook is read again, since GitHub's listing can trail it. */
const TRIAGE_RELIST_GRACE_MS = 60_000;
const GITHUB_CALLS_LOG_MS = 60_000;
/** How often E2B sandboxes are swept and extended; well inside their one-hour timeout. */
const E2B_TEND_MS = 10 * 60_000;
/** A GitHub token that could not be renewed is tried again within its remaining quarter hour. */
const GITHUB_TOKEN_RETRY_MS = 60_000;
const GITHUB_TOKEN_RETRY_MAX_MS = 5 * 60_000;
/** A key is saved as several writes, so a workspace rolls once its writes stop for this long. */
const WORKFLOW_RELEASE_QUIET_MS = 3_000;
/** A roll that failed, or found another hub process rolling the workspace, is tried again about this much later. */
const WORKFLOW_RELEASE_RETRY_MS = 10 * 60_000;
/** Each roll holds a reserved connection while it waits for a listener, so few run at once and the pool stays free. */
const WORKFLOW_RELEASE_CONCURRENCY = 2;

const ROOT = resolve(import.meta.dir, "../../..");
const V = resolve(ROOT, "vendor/interchange");
const env = loadHubEnv(process.env);
const database = databaseConfig(env);
const githubOrigin = githubApiOrigin(env);

await assertMigrated(database);

const credentialCipher = createEnvKeyCredentialCipher(hexDecode(env.CREDENTIAL_ENCRYPTION_KEY));
const localSidecarDataRoot = `${env.HUB_DATA_DIR}/local-sidecars`;
const localSidecarCap = localSidecarMaxDeployments(env);
const local = createLocalProcessSidecarProvisioner({
  dataRoot: localSidecarDataRoot,
  ...(env.HUB_SIDECAR_STOP_TIMEOUT_MS !== undefined && { stopTimeoutMs: Number(env.HUB_SIDECAR_STOP_TIMEOUT_MS) }),
  spawnSidecar: createSpawnLocalSidecar({
    interchangeDir: V,
    credentialEncryptionKey: env.SIDECAR_CREDENTIAL_ENCRYPTION_KEY,
    maxActiveDeployments: localSidecarCap,
    processEnv: childProcessEnv(env),
  }),
  manifests: createLocalSidecarManifestStore({
    dataRoot: localSidecarDataRoot,
    cipher: credentialCipher,
    log: logJson,
  }),
  capacity: createHostCapacity({ cgroupRoot: "/sys/fs/cgroup", meminfo: "/proc/meminfo" }),
  adapterManifest: SIDECAR_ADAPTER_MANIFEST,
  onAccepted: notePlaced,
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
const codeReviewProbes = [...dockerPlaces(docker), { guide: E2B_PLACE, found: e2b }, { guide: RAILWAY_PLACE, found: railway }];
const noIsolatedPlace = isolatedPlaceBootWarning(workloadProvisioners.length > 0, codeReviewProbes.map((probe) => probe.guide));
if (noIsolatedPlace) logJson(noIsolatedPlace);
function placeDeployments(db: DB["db"]) {
  return createPlacementChooser({ db, local: local.provisioner, maxDeployments: localSidecarCap });
}

let shuttingDown = false;
let cronTicker: CronTicker | undefined;
let triageLoop: ReturnType<typeof createReconcileLoop> | undefined;
let tokenLoop: ReturnType<typeof createReconcileLoop> | undefined;
let coalescer: Coalescer | undefined;
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
  tokenLoop?.stop();
  coalescer?.stop();
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
const ipHeaders = clientIpHeaders(env);
if (ipHeaders === undefined) logJson({ level: "warn", msg: "auth_client_ip_unresolved", reason: "Unknown host: sign-in rate limits may be shared between callers." });
const email = emailSettings(env);
const smtp = email === undefined ? undefined : createSmtpEmail(email);
const composition = await createInterchangeHub({
  database,
  settings: interchangeSettings(env),
  authConfig: { ...signIn, baseURL: env.BETTER_AUTH_BASE_URL, secret: env.BETTER_AUTH_SECRET, trustedOrigins: portalOrigin, portalOrigin: inviteLinkOrigin(env), ...(ipHeaders && { clientIpHeaders: ipHeaders }), ...(smtp && { email: { resetPassword: smtp.passwordReset, verifyEmail: smtp.verifyEmail } }) },
  credentialCipher,
  adapterManifest: SIDECAR_ADAPTER_MANIFEST,
  sidecarProvisioners,
  sidecarProvisionerChooser: placeDeployments,
  probeSidecarProvisioners: sidecarProvisioners,
  probeSidecarCapabilityRules: workloadProvisioners.length > 0 ? [{ capability: "isolation:workload", effect: "require" }] : [],
  extraRunTokenRoutes: MANAGER_RUN_TOKEN_ROUTES,
});
const stock = composition.server;
composition.sidecarRouter.events.on("sidecar.allocated.connected", notePlaced);

/** The hub's credentials, and the push that takes back from sidecars an App key a read moved to the hub. */
const credentialDeps = {
  db: composition.db,
  cipher: composition.credentialCipher,
  onKeyMoved: function pushMovedKeyBlank(tenantId: string): Promise<void> {
    return githubToken.push(tenantId);
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
  conditionRegistry: HUB_CONDITION_REGISTRY,
});
/** A workspace with a host's listener live runs that host's pull requests in managers. */
function liveListenerOf(tenantId: string, source: RepoSource): Promise<LiveDeployment | undefined> {
  return liveListener(composition.db, tenantId, source);
}
async function listenerAddress(tenantId: string, source: RepoSource): Promise<string | undefined> {
  return (await liveListenerOf(tenantId, source))?.address;
}
const { supersede, supersedeAll } = createSupersede({
  db: composition.db,
  async cancel(tenantId, runId, reason) {
    await composition.workflowLifecycleService.requestCancellation(tenantId, runId, reason);
  },
  log: logJson,
});
const toListener = createManagerIntake({
  db: composition.db,
  listener: listenerAddress,
  readPull: function readPull(tenantId, record, number) {
    return pullRequests.withDiff(tenantId, record, number);
  },
  withAppLogin: function appLoginOf(tenantId, payload) {
    return withAppLogin(composition.db, tenantId, payload);
  },
  openHeads: async function openHeads(tenantId, record) {
    const read = await tenantOpenHeads(tenantId);
    if (!read) throw new Error("no active source credential");
    return read(record);
  },
  gate: function gateOf(tenantId, record, number, request) {
    return pauseGate(tenantId, record, number, request);
  },
  deliver: function deliverOf(tenantId, address, payload) {
    return deliverToListener(tenantId, address, payload);
  },
  supersede,
  log: logJson,
});
const wakeManager = createManagerWake({
  db: composition.db,
  listener: listenerAddress,
  deliver: function deliverOf(tenantId, address, payload) {
    return deliverToListener(tenantId, address, payload);
  },
});
const wakeOverdue = createOverdueWake({ db: composition.db, wake: wakeManager, log: logJson });
mountTenantRoutes(composition.app, { db: composition.db, requireGrant, log: logJson, wake: wakeManager, supersede, now });
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
// A tenant's system principal never changes once minted.
const systemSenders = new Map<string, ResolvedSenderPrincipal>();
/** The tenant system sender a run trigger is signed as, minted once, with the coordinates Interchange's sender gate admits. */
async function systemSenderOf(senderLocalPart: string, tenantId: string): Promise<ResolvedSenderPrincipal> {
  const key = `${senderLocalPart}@${tenantId}`;
  const cached = systemSenders.get(key);
  if (cached !== undefined) return cached;
  const domain = await tenantDomain(tenantId);
  await systemSender.resolve({ tenantId, domain, localPart: senderLocalPart });
  const resolved = await resolveSenderPrincipal(composition.db, composition.principalKeyStore, `${senderLocalPart}@${domain}`);
  if (!resolved) throw new Error(`no ${senderLocalPart} system principal in tenant ${tenantId}`);
  systemSenders.set(key, resolved);
  return resolved;
}
function runTriggerDeliverer(senderLocalPart: string): MailDeliverer {
  const materialize = createMailTriggeredRunGrantsMaterializer({
    db: composition.db,
    principalKeyStore: composition.principalKeyStore,
    runTokenStore: composition.runTokenStore,
    grantStore: createGrantStore(composition.db),
    registry: HUB_CONDITION_REGISTRY,
  });
  return {
    async to(address, content, tenantId, subject) {
      const sender = await systemSenderOf(senderLocalPart, tenantId);
      const deliverer = createRunTriggerDeliverer({
        router: composition.sidecarRouter,
        materialize: readyMaterializer(systemSenderMaterializer(materialize, sender)),
        tenantDomain,
        senderLocalPart,
        systemSender,
      });
      await deliverer.to(address, content, tenantId, subject);
    },
  };
}
cronTicker = createCronTicker({
  db: composition.db,
  deliver: createRunTriggerCronDeliver(runTriggerDeliverer("cron")),
  onDeliveryError: function logCronDeliveryError(error, schedule) { logJson({ level: "warn", msg: "cron_delivery_failed", scheduleId: schedule.id, tenantId: schedule.tenantId, error: String(error) }); },
});
cronTicker.start();
const automation = createAutomation({ db: composition.db, now });
const verdictRecordStore = createVerdictRecordStore(composition.db);
const portalGrantStore = createGrantStore(composition.db);
const trustedPortalOrigins = [new URL(env.BETTER_AUTH_BASE_URL).origin, ...portalOrigin];
async function authorizePortal(principalId: string, tenantId: string, resource: string, action: string): Promise<boolean> {
  const result = await authorize(portalGrantStore, principalId, tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY });
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
const codeReviewRuns = createCodeReviewRuns({ db: composition.db, read: pullRequests.withDiff, log: logJson });
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


const GITHUB_SENDER = TRIAGE_MAIL_SENDER;
const githubDeliverer = runTriggerDeliverer(GITHUB_SENDER);
const deliverToListener = checkedBitbucketDelivery(async function deliverMail(tenantId, address, payload) {
  await githubDeliverer.to(address, JSON.stringify(await withAppLogin(composition.db, tenantId, payload)), tenantId, undefined);
}, tenantBitbucket);
const githubToken = createGithubTokenRenewal({ ...credentialDeps, githubApiOrigin: githubOrigin, router: composition.sidecarRouter, loadRunCredentials: composition.loadRunCredentials, log: logJson });
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
async function sendTriageMail(job: TriageJob): Promise<void> {
  await sendToListener(job.tenantId, job.payload);
}
/**
 * A workspace's pull requests run in managers its listener deploys; one without a listener runs none. Each pull request
 * passes the pause gate at intake, whatever sent it: a paused one is dropped, and the reconciler leaves it alone until its
 * label comes off.
 */
async function sendToListener(tenantId: string, payload: unknown): Promise<void> {
  if (!(await toListener(tenantId, payload))) throw new TriageStoppedError(repoSourceOf(asRecord(payload)?.["repoSource"]));
}
const placeCodeReview = createCodeReviewPlacement(composition.db, composition.sidecarPlugins);
const pauseGate = createPauseGate({ readHead: pullRequests.head, log: logJson });
const tenantSources = { ...credentialDeps, githubApiOrigin: githubOrigin, tenantBitbucket };
const tenantOpenPrs = keptOpenPrs(createTenantOpenPrs(tenantSources), repoReads);
const openPullsCache = createOpenPullsCache(now);
const memberOpenPulls = createMemberOpenPulls({ cache: openPullsCache, ...credentialDeps, list: tenantOpenPrs, authorize: authorizePortal });
const repoActivity = createRepoActivity(now, { quietMs: TRIAGE_RELIST_QUIET_MS, graceMs: TRIAGE_RELIST_GRACE_MS });
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
  quiet: repoActivity.quiet,
});
const checkPackStore = { db: composition.db, artifacts: composition.db, automaticKinds: automation.automaticKinds, log: logJson };
function readStoredCheckPack(tenantId: string, repo: string, source: RepoSource) {
  return loadCheckPack(checkPackStore, tenantId, repo, source);
}
function settleRepoPolicy(tenantId: string, repo: string, source: RepoSource) {
  return settlePolicy({ ...checkPackStore, policyFile: policyFile.current }, tenantId, repo, source);
}
function chosenFileRefusal(tenantId: string, repo: string, source: RepoSource, policy: Record<string, unknown>) {
  return fileRefusal({ ...checkPackStore, policyFile: policyFile.current }, tenantId, repo, source, policy);
}
async function readCheckPack(tenantId: string, repo: string, source: RepoSource) {
  return (await settleRepoPolicy(tenantId, repo, source)).read;
}
/** A push that lands a file matching the saved rules retires them now, so an edit after it is not taken for a difference. */
async function refreshPolicyFile(tenantId: string, repo: string, source: RepoSource) {
  const state = await policyFile.onPush(tenantId, repo, source);
  if (state) await settleRepoPolicy(tenantId, repo, source);
  return state;
}
async function githubSenderPrincipal(tenantId: string): Promise<string> {
  return (await systemSenderOf(GITHUB_SENDER, tenantId)).principalId;
}
function now(): Date {
  return new Date();
}
function reconcileTenants() {
  return composition.db.select({ id: schema.tenant.id, domain: schema.tenant.domain, config: schema.tenant.config }).from(schema.tenant);
}
const launchSpecs = createWorkflowRunLaunchSpecStore(composition.db);
async function deployListener(request: DeployRequest): Promise<string> {
  const prepared = await composition.workflowAllocationService.prepareProvisionedDeployment({
    tenantId: request.tenantId,
    anchorRunId: generateId("workflowRun"),
    deploymentDomain: await tenantDomain(request.tenantId),
    source: { kind: "asset", assetId: request.assetId, package: { format: "source", commitSha: request.commitSha, packageName: request.packageName } },
    entry: request.entry,
    definitionAssetId: request.assetId,
    sessionId: generateId("session"),
    sourceAuthorityPrincipalId: request.principalId,
    sourceOfferingIds: request.offerings.ids,
    defaultSourceOfferingId: request.offerings.defaultId,
    deployContent: { systemPrompt: "" },
  });
  return prepared.anchorRunId;
}
async function workspacePublisher(tenantId: string): Promise<Publisher> {
  const { principalId } = await systemSenderOf(TRIAGE_PUBLISHER, tenantId);
  await setUpPublisher(composition.db, tenantId, principalId, now());
  return { tenantId, principalId };
}
// The portal build writes the workflows under its public files, which the hub serves from PORTAL_DIR once built.
const workflowBundleDir = resolve(env.PORTAL_DIR ?? resolve(ROOT, "apps/web/public"), "packages");
const workflowRollout = createWorkflowRollout({
  db: composition.db,
  assets: composition.assetService,
  repoStore: composition.repoStore,
  bundle: bundleAt(workflowBundleDir),
  publisher: workspacePublisher,
  models: function modelsOf(tenantId) {
    return catalogModels(composition.db, tenantId);
  },
  connectedSources: function sourcesOf(tenantId) {
    return connectedSources(composition.db, tenantId);
  },
  deployments: function deploymentsOf(tenantId, workflow) {
    return liveDeployments(composition.db, launchSpecs, tenantId, workflow);
  },
  deploy: deployListener,
  state: function stateOf(runId) {
    return deploymentState(composition.db, runId);
  },
  async cancel(tenantId, runId) {
    await composition.workflowLifecycleService.requestCancellation(tenantId, runId, "replaced");
  },
  status(tenantId, runId) {
    return composition.workflowLifecycleService.getStatus(tenantId, runId);
  },
  lock: createWorkspaceLock(composition.db.$client),
  sleep: Bun.sleep,
  now,
  log: logJson,
});
const workflowReleases = createRolloutQueue(workflowRollout, { quietMs: WORKFLOW_RELEASE_QUIET_MS, retryMs: WORKFLOW_RELEASE_RETRY_MS, concurrency: WORKFLOW_RELEASE_CONCURRENCY, random: Math.random }, logJson);
const workflowsBundled = bundled(workflowBundleDir);
/** A host's credential was written or replaced: its listener starts again with it, from the newest release. */
function rollHost(source: RepoSource) {
  return function rollWithCredentials(tenantId: string): void {
    if (workflowsBundled) workflowReleases.request(tenantId, [source]);
  };
}
/** The host's listeners still live after stock gave up stopping them. */
async function stuckListeners(tenantId: string, source: RepoSource): Promise<string[]> {
  const stuck: string[] = [];
  for (const listener of await resolveLiveDeployments(composition.db, tenantId, TRIAGE_LISTENERS[source])) {
    if (!listener.cancelling) continue;
    const run = await composition.workflowLifecycleService.getStatus(tenantId, listener.runId);
    if (run && stopGivenUp(run)) stuck.push(listener.runId);
  }
  return stuck;
}
const watchListeners = createListenerWatch({
  connectedSources: function sourcesOf(tenantId) {
    return connectedSources(composition.db, tenantId);
  },
  listener: liveListenerOf,
  stuck: stuckListeners,
  allocation: function allocationOf(runId) {
    return deployedAllocation(composition.db, runId);
  },
  routable: function routableOf(target) {
    return composition.sidecarRouter.isAllocatedWorkflowActive(target);
  },
  ensure: function rollWorkspace(tenantId) {
    if (workflowsBundled) workflowReleases.ensure(tenantId);
  },
  replace: function replaceListener(tenantId, source) {
    return workflowsBundled && workflowReleases.replace(tenantId, source);
  },
  log: logJson,
});
const managerRuns = createManagerRuns(composition.db, verdictRecordStore, now);
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
const reconcilePolicy = triageReconcilePolicy(env);

/** One host's reconciler. */
function reconcilerFor(source: RepoSource) {
  return createTriageReconciler({
    source,
    tenants: reconcileTenants,
    listener: liveListenerOf,
    headChecks: tenantHeadChecks,
    verdicts: verdictRecordStore,
    openHeadsFor: tenantOpenHeads,
    activity: repoActivity,
    managerRuns,
    store: triageStateStore,
    readCheckPack,
    send: sendTriageMail,
    policy: reconcilePolicy,
    now,
    log: logJson,
  });
}

const reconcilers = REPO_SOURCES.map(reconcilerFor);
async function reconcileAll(): Promise<ReconcileOutcome> {
  // A host removed through the stock credential route tells the hub nothing, so each pass releases what it left running.
  for (const tenant of await reconcileTenants()) {
    await releaseHostsOf(tenant.id);
    await watchListeners(tenant.id);
    await supersedeAll(tenant.id);
    await wakeOverdue(tenant.id);
  }
  await endNeverRan(composition.db, new Date(), composition.workflowLifecycleService.requestCancellation, logJson);
  const outcomes: ReconcileOutcome[] = [];
  for (const reconcile of reconcilers) outcomes.push(await reconcile());
  const retry = outcomes.some((outcome) => outcome.retry);
  const limits = outcomes.flatMap((outcome) => outcome.retryAt ?? []);
  return limits.length === 0 ? { retry } : { retry, retryAt: Math.min(...limits) };
}
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
  listener: liveListenerOf,
  managerRuns,
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
  toListener,
  passRequest: function managerPassRequest(tenantId, pr, runId, head) {
    return passRequest(composition.db, tenantId, pr, runId, head);
  },
  log: logJson,
});
const kickTriage = triageLoop.kick;
const releaseDisconnected = createHostRelease({
  connectedSources: function connectedSourcesOf(tenantId) {
    return connectedSources(composition.db, tenantId);
  },
  liveDeployments: function liveOf(tenantId, workflow) {
    return resolveLiveDeployments(composition.db, tenantId, workflow);
  },
  async cancel(tenantId, runId) {
    await composition.workflowLifecycleService.requestCancellation(tenantId, runId, "source_disconnected");
  },
  log: logJson,
});
async function releaseHostsOf(tenantId: string): Promise<void> {
  try {
    await releaseDisconnected(tenantId);
  } catch (err) {
    logJson({ level: "error", msg: "triage_source_release_failed", tenantId, error: String(err) });
  }
}
async function onSourcesChanged(tenantId: string): Promise<void> {
  await releaseHostsOf(tenantId);
  kickTriage();
}
const syncInstallations = createInstallationSync({
  ...credentialDeps,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
  onSynced: function installationsSynced(tenantId) {
    void renewGithubToken(tenantId);
    void onSourcesChanged(tenantId);
    if (workflowsBundled) workflowReleases.request(tenantId, []);
  },
});
function setTimer(fire: () => Promise<void>, ms: number): () => void {
  const handle = setTimeout(fire, ms);
  return function cancel() {
    clearTimeout(handle);
  };
}
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
async function recheckOpenPulls(tenantId: string, repo: string, except: number | null): Promise<number> {
  const due = await markBaseMoved(triageStateStore, tenantId, repo, except, now(), reconcilePolicy);
  if (due > 0) kickTriage();
  return due;
}
async function sendBacklogMail(tenantId: string, payload: unknown) {
  await sendToListener(tenantId, payload);
}
const deliveryCache = new DeliveryCache({ filePath: `${env.HUB_DATA_DIR}/delivery-cache.json` });
const bridge = createBridgeHandler({
  db: credentialDeps.db,
  cipher: credentialDeps.cipher,
  cache: deliveryCache,
  coalescer,
  readCheckPack,
  openHeadFor: tenantOpenHead,
  recheckOpenPulls,
  refreshPolicyFile,
  heard: repoActivity.heard,
  startBacklog: createBacklogStart({ readCheckPack, sendMail: sendBacklogMail, log: logJson }),
  repoChanged: repoReads.changed,
});
const providerHooks = createProviderHookApp(createProviderHookHandler({
  db: credentialDeps.db,
  cipher: credentialDeps.cipher,
  cache: deliveryCache,
  coalescer,
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
  connectGithubApp: createGithubAppConnection({ ...credentialDeps, authorize: authorizePortal, githubApiOrigin: githubOrigin, renewal: githubToken, onConnected: rollHost("github") }),
  prActions: githubPrActions,
  bitbucketCodeReviewSend: createBitbucketCodeReviewSend({
    ...credentialDeps,
    authorize: authorizePortal,
    tenantBitbucket,
    codeReviews: codeReviewRuns,
    changed: repoReads.changed,
    log: logJson,
  }),
  heldDos: githubHeldDos,
  prTriage: githubPrTriage,
  policyRead: createGithubPolicyRead({ readCheckPack }),
  policyFileRead: policyFile.fileRoute,
  policyFileExport: policyFile.exportRoute,
  policyFilePatch: policyFile.patchRoute,
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
    managerRuns,
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
    authorize: authorizePortal,
    workflows: APPROVAL_WORKFLOWS,
  }),
  workflowVersions: createWorkflowVersions({
    db: composition.db,
    launchSpecs,
    up: function upOf(anchorRunId) {
      return deploymentUp(composition.db, anchorRunId);
    },
    rollouts: workflowRollout.rollouts,
    sidecar: function sidecarUsage() {
      return localSidecarUsage(composition.db, local.provisioner, localSidecarCap);
    },
  }),
  codeReviewPlace: createCodeReviewPlace({ authorize: authorizePortal, place: placeCodeReview, probes: codeReviewProbes }),
  codeReviewRun: createCodeReviewRun({ db: composition.db, authorize: authorizePortal, place: placeCodeReview, readCheckPack, readHead: pullRequests.head, send: sendToListener }),
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
    onCredentialsReplaced: rollHost("bitbucket-datacenter"),
    now,
    log: logJson,
  }),
  sessions: createSessions(composition.db),
});
// Mounted so the stock /openapi.json lists the routes; requests reach them
// through routeRequest, past the stock logger, which would log the callback's
// one-time GitHub code in its query.
composition.app.route("/", integrations);
composition.app.route("/", providerHooks);

const refuseUnverified = createVerifiedGate({ isHubOwner, getSession: composition.getSession, allowedEmails: signIn.allowedEmails });
const servePortal = env.PORTAL_DIR === undefined ? undefined : createPortalHandler(env.PORTAL_DIR);

/** A stock credential write: App JSON it leaves in `github` is moved to the hub and taken back from sidecars at once. */
const CREDENTIAL_WRITE = /^\/api\/tenants\/([^/]+)\/credentials(?:\/([^/]+))?$/;
const PROVIDER_WRITE = /^\/api\/tenants\/([^/]+)\/providers(?:\/([^/]+))?$/;

function decodedSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Rolls the workspace after a release write succeeds, starting again the listeners of the hosts the write reaches. */
async function forwardReleaseWrite(req: Request, path: string, forward: () => Promise<Response> | Response): Promise<Response> {
  const release = workflowsBundled ? await releaseWriteOf(composition.db, req, path) : undefined;
  const response = await forward();
  if (release && response.ok) workflowReleases.request(release.tenantId, release.redeploy);
  return response;
}

async function routeRequest(req: Request, server: Parameters<typeof stock.fetch>[1]): Promise<Response> {
  // Guards read the path stock Hono routes on; one that does not fully decode is refused rather than matched in part.
  try {
    decodeURI(new URL(req.url).pathname);
  } catch {
    return logRefusal(req, Response.json({ error: "bad_path" }, { status: 400 }));
  }
  const path = getPath(req);
  if (servePortal && isPortalRequest(req, path)) return servePortal(req);
  if (path === HOOK_MOUNT_PATH || path.startsWith(`${HOOK_MOUNT_PATH}/`)) {
    // Fail fast on bodies the stock hook app would reject with 413, before
    // hook lookup, decrypt or HMAC work. The bridge re-checks actual bytes
    // while reading (Content-Length may be missing or dishonest).
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (isProviderHookPath(path)) return providerHooks.fetch(req);
    if (req.headers.get("x-hub-signature-256") !== null) {
      const rest = path.slice(HOOK_MOUNT_PATH.length);
      const target = hookTarget(req, rest);
      if (!target) return Response.json({ error: "unknown_hook" }, { status: 404 });
      return bridge(req, target);
    }
    // @corbits/webhooks 0.3.1 fires a run without naming its sender, which Interchange's sender gate refuses.
    return Response.json({ error: "unknown_hook" }, { status: 404 });
  }
  const unverified = await refuseUnverified(req, path);
  if (unverified) return logRefusal(req, unverified);
  // The integrations app logs its requests by path alone: the callback's query
  // carries the one-time GitHub code.
  if (path.startsWith(INTEGRATIONS_PREFIX)) return integrations.fetch(req);
  if (req.method === "PATCH") {
    const tenantMatch = /^\/api\/tenants\/([^/]+)$/.exec(path);
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
  const providerWritten = req.method === "POST" || req.method === "PATCH" ? PROVIDER_WRITE.exec(path) : null;
  const providerTenant = providerWritten ? decodedSegment(providerWritten[1]!) : undefined;
  if (providerTenant !== undefined) {
    const refusedProvider = await appKeyProviderWriteRefusal(composition.db, providerTenant, providerWritten?.[2] === undefined ? undefined : decodedSegment(providerWritten[2]), req);
    if (refusedProvider) return refusedProvider;
  }
  const written = req.method === "POST" || req.method === "PATCH" ? CREDENTIAL_WRITE.exec(path) : null;
  const writtenTenant = written ? decodedSegment(written[1]!) : undefined;
  if (writtenTenant === undefined) {
    return forwardReleaseWrite(req, path, function forwardStock() {
      return stock.fetch(req, server);
    });
  }
  const refused = await appKeyWriteRefusal(composition.db, writtenTenant, written?.[2] === undefined ? undefined : decodedSegment(written[2]), req);
  if (refused) return refused;
  return forwardReleaseWrite(req, path, async function forwardCredential() {
    const response = await stock.fetch(req, server);
    // A backstop for App JSON a write still leaves in `github`.
    if (response.ok) await githubToken.secure(writtenTenant);
    return response;
  });
}

triageLoop.start();
tokenLoop.start();

/** Rolls every workspace onto a new build's release, as many at once as the queue allows. */
async function rollWorkspaces(): Promise<void> {
  if (!workflowsBundled) {
    logJson({ level: "error", msg: "workflow_release_unbundled", path: workflowBundleDir, error: "The hub found no built workflows here, so it publishes and deploys none. Build the portal, or set PORTAL_DIR to its build." });
    return;
  }
  try {
    await Promise.all((await triageTenants(composition.db)).map((tenantId) => workflowReleases.run(tenantId)));
  } catch (error) {
    logJson({ level: "error", msg: "workflow_release_boot_failed", error: errorText(error) });
  }
}
void rollWorkspaces();

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
