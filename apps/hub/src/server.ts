// Composition over the stock Interchange hub bootstrap (./interchange-hub.ts).
// GitHub manifest start/callback and PR actions are custom domain routes
// because GitHub must return a one-time code to a confidential server before
// any browser can observe it. GitHub-signed hook requests go to the legacy
// bridge until upstream ships a GitHub verifier. Every other /api/* path falls
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
import { createInterchangeHub } from "./interchange-hub.js";
import { createLocalProcessSidecarProvisioner } from "./sidecar/local-provisioner.js";
import { createLocalSidecarManifestStore } from "./sidecar/manifest-store.js";
import { restoreLocalSidecars } from "./sidecar/restore.js";
import { createSpawnLocalSidecar } from "./sidecar/spawn.js";
import { buildSidecarAdapterManifest } from "./sidecar-config.js";
import { createPortalHandler, isPortalRequest, withPortalCors } from "./portal.js";
import { createInstallationSync, GITHUB_INSTALLATIONS_PATH } from "./github/installation-sync.js";
import { AUTH_METHODS_PATH, authMethods } from "./auth.js";
import { databaseConfig, interchangeSettings, githubApiOrigin, loadHubEnv, migrationEnv, signInSettings, triageBatchSize, triageReconcileIntervalMs, triageReconcilePolicy, triageRotateAfterRuns } from "./env.js";
import { HOOK_MOUNT_PATH, createStockHookApp, migrateWebhooks } from "./hooks.js";
import { createBridgeHandler, logJson, MAX_BODY_BYTES, type BridgeDeps } from "./github/bridge.js";
import { DeliveryCache } from "./github/dedupe.js";
import { createDeploymentRotation, NoLiveDeploymentError, resolveLiveDeployment, resolveLiveDeployments } from "./github/deployment.js";
import { createGithubOpenPulls, GITHUB_OPEN_PULLS_PATH } from "./github/open-pulls.js";
import { createGithubPrActions, GITHUB_PR_ACTIONS_PATH } from "./github/pr-actions.js";
import { createGithubPrDetails, GITHUB_PR_DETAILS_PATH } from "./github/pr-details.js";
import { createGithubPrTriage, GITHUB_PR_TRIAGE_PATH } from "./github/pr-triage.js";
import { loadCheckPack } from "./github/check-pack-store.js";
import { createReconcileLoop } from "./github/reconcile-loop.js";
import { createTriageReconciler } from "./github/triage-reconciler.js";
import { createPullHeadReader, createTenantOpenHeads } from "./github/tenant-open-heads.js";
import { createSettledStatusReader, createTriageRuns } from "./github/triage-runs.js";
import { createTriageStateStore } from "./github/triage-state-store.js";
import {
  GITHUB_MANIFEST_CALLBACK_PATH,
  GITHUB_MANIFEST_PATH,
  createGithubManifestIntegration,
  migrateGithubManifest,
} from "./github/manifest.js";
import { migrateRepoEnabledFlag, prepareCorbitsTriagePatch } from "./github/tenant-config.js";
import { PR_TRIAGE_ADDRESS, workflow as prTriageWorkflow } from "../../../packages/triage-workflows/src/pr-triage.js";
import { PR_TRIAGE_HISTORICAL_ADDRESS, workflow as prTriageHistoricalWorkflow } from "../../../packages/triage-workflows/src/pr-triage-historical.js";
import { githubRead, githubWrite } from "../../../packages/github-tool/src/index.js";

const EXPECTED_DEPLOYMENT_SET = {
  workflows: [
    { address: PR_TRIAGE_ADDRESS, id: prTriageWorkflow.id },
    { address: PR_TRIAGE_HISTORICAL_ADDRESS, id: prTriageHistoricalWorkflow.id },
  ],
  tools: [githubRead.id, githubWrite.id],
};

// Runs whose trigger and outcome the reconciler remembers between passes.
const TRIAGE_KNOWN_RUNS = 10_000;
const TRIAGE_RETRY_MS = 15_000;
const TRIAGE_RETRY_MAX_MS = 120_000;
const ROOT = resolve(import.meta.dir, "../../..");
const V = resolve(ROOT, "vendor/interchange");
const env = loadHubEnv(process.env);
const database = databaseConfig(env);
const githubOrigin = githubApiOrigin(env);
const sidecarAdapterManifest = buildSidecarAdapterManifest(env.HUB_DATA_DIR, githubOrigin);

await Bun.$`bunx drizzle-kit migrate`.cwd(`${V}/packages/db`).env({ PATH: process.env["PATH"], HOME: process.env["HOME"], ...migrationEnv(database) }).quiet();
console.log("migrations applied");
await migrateWebhooks(database);
{
  const { schema = "public", statementTimeoutMs: _, ...connection } = database;
  await runArtifactMigrations(connection, { schema });
  console.log("artifact migrations applied");
  await runCronMigrations(connection, { schema });
  console.log("cron migrations applied");
}

const credentialCipher = createEnvKeyCredentialCipher(hexDecode(env.CREDENTIAL_ENCRYPTION_KEY));
const localSidecarDataRoot = `${env.HUB_DATA_DIR}/local-sidecars`;
const local = createLocalProcessSidecarProvisioner({
  dataRoot: localSidecarDataRoot,
  ...(env.HUB_SIDECAR_STOP_TIMEOUT_MS !== undefined && { stopTimeoutMs: Number(env.HUB_SIDECAR_STOP_TIMEOUT_MS) }),
  spawnSidecar: createSpawnLocalSidecar({
    interchangeDir: V,
    credentialEncryptionKey: env.SIDECAR_CREDENTIAL_ENCRYPTION_KEY,
    adapterManifest: sidecarAdapterManifest,
  }),
  manifests: createLocalSidecarManifestStore({
    dataRoot: localSidecarDataRoot,
    cipher: credentialCipher,
  }),
});

let shuttingDown = false;
let cronTicker: CronTicker | undefined;
let triageLoop: ReturnType<typeof createReconcileLoop> | undefined;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  cronTicker?.stop();
  triageLoop?.stop();
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
const composition = await createInterchangeHub({
  database,
  settings: interchangeSettings(env),
  authConfig: { ...signIn, baseURL: env.BETTER_AUTH_BASE_URL, secret: env.BETTER_AUTH_SECRET, trustedOrigins: portalOrigin },
  credentialCipher,
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
    materialize: createMailTriggeredRunGrantsMaterializer({
      db: composition.db,
      principalKeyStore: composition.principalKeyStore,
      grantStore: createGrantStore(composition.db),
    }),
    tenantDomain,
    senderLocalPart,
    systemSender,
  });
}
cronTicker = createCronTicker({
  db: composition.db,
  deliver: createRunTriggerCronDeliver(runTriggerDeliverer("cron")),
});
cronTicker.start();
await migrateGithubManifest(composition.db);
await migrateRepoEnabledFlag(composition.db);
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
});
const githubPrActions = createGithubPrActions({
  db: composition.db,
  cipher: composition.credentialCipher,
  getSession: composition.getSession,
  trustedPortalOrigins,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
});
const githubPrDetails = createGithubPrDetails({
  db: composition.db,
  cipher: composition.credentialCipher,
  getSession: composition.getSession,
  trustedPortalOrigins,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
});

const githubOpenPulls = createGithubOpenPulls({
  db: composition.db,
  cipher: composition.credentialCipher,
  getSession: composition.getSession,
  trustedPortalOrigins,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
});

const hookDeps = { db: composition.db, cipher: composition.credentialCipher };
const hookApp = createStockHookApp(
  hookDeps,
  composition.principalKeyStore,
  composition.sidecarRouter,
);

const GITHUB_SENDER = "github";
const githubDeliverer = runTriggerDeliverer(GITHUB_SENDER);
async function deliverToDeployment(tenantId: string, address: string, payload: unknown): Promise<void> {
  await githubDeliverer.to(address, JSON.stringify(payload), tenantId, undefined);
}
const sendBridgeMail: BridgeDeps["sendMail"] = async function sendBridgeMail(tenantId, workflow, payload) {
  const live = await resolveLiveDeployment(composition.db, tenantId, workflow);
  if (!live) throw new NoLiveDeploymentError(workflow);
  await deliverToDeployment(tenantId, live.address, payload);
};
function readCheckPack(tenantId: string, repo: string) {
  return loadCheckPack(composition.db, tenantId, repo);
}
// A tenant's system principal never changes once minted.
const githubSenderPrincipals = new Map<string, string>();
/** Hub-written triage state is recorded as the tenant's GitHub system sender. */
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
function livePrTriageDeployments(tenantId: string) {
  return resolveLiveDeployments(composition.db, tenantId, prTriageWorkflow.id);
}
const deploymentRotation = createDeploymentRotation({
  db: composition.db,
  launchSpecs: createWorkflowRunLaunchSpecStore(composition.db),
  allocation: composition.workflowAllocationService,
  lifecycle: composition.workflowLifecycleService,
  mayDeploy: function mayDeploy(principalId, tenantId) {
    return authorizePortal(principalId, tenantId, "workflow:*", "create");
  },
});
const tenantOpenHeads = createTenantOpenHeads({ db: composition.db, cipher: composition.credentialCipher, githubApiOrigin: githubOrigin });
const triageStateStore = createTriageStateStore({ db: composition.db, writerFor: githubSenderPrincipal, log: logJson });
const observeTriageRuns = createTriageRuns({
  runReader: composition.runReader,
  readSettled: createSettledStatusReader(composition.db),
  maxKnownRuns: TRIAGE_KNOWN_RUNS,
});
const reconcilePolicy = triageReconcilePolicy(env);
const reconcileTriage = createTriageReconciler({
  tenants: reconcileTenants,
  liveDeployments: livePrTriageDeployments,
  rotation: { afterRuns: triageRotateAfterRuns(env), ...deploymentRotation },
  openHeadsFor: tenantOpenHeads,
  observeRuns: observeTriageRuns,
  store: triageStateStore,
  readCheckPack,
  deliver: deliverToDeployment,
  policy: reconcilePolicy,
  batchSize: triageBatchSize(env),
  now,
  log: logJson,
});
triageLoop = createReconcileLoop(reconcileTriage, { intervalMs: triageReconcileIntervalMs(env), retryMs: TRIAGE_RETRY_MS, retryMaxMs: TRIAGE_RETRY_MAX_MS }, logJson);
const githubPrTriage = createGithubPrTriage({
  db: composition.db,
  cipher: composition.credentialCipher,
  getSession: composition.getSession,
  trustedPortalOrigins,
  authorize: authorizePortal,
  pullHead: createPullHeadReader({ githubApiOrigin: githubOrigin }),
  readCheckPack,
  liveDeployments: livePrTriageDeployments,
  observeRuns: observeTriageRuns,
  store: triageStateStore,
  deliver: deliverToDeployment,
  policy: reconcilePolicy,
  now,
  log: logJson,
});
const syncInstallations = createInstallationSync({
  db: composition.db,
  cipher: composition.credentialCipher,
  getSession: composition.getSession,
  trustedPortalOrigins,
  githubApiOrigin: githubOrigin,
  authorize: authorizePortal,
  onSynced: triageLoop.kick,
});
const bridge = createBridgeHandler({
  db: hookDeps.db,
  cipher: hookDeps.cipher,
  cache: new DeliveryCache({ filePath: `${env.HUB_DATA_DIR}/delivery-cache.json` }),
  sendMail: sendBridgeMail,
  readCheckPack,
});

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

const servePortal = env.PORTAL_DIR === undefined ? undefined : createPortalHandler(env.PORTAL_DIR);

async function routeRequest(req: Request, server: Parameters<typeof stock.fetch>[1]): Promise<Response> {
  if (servePortal && isPortalRequest(req)) return servePortal(req);
  const url = new URL(req.url);
  if (url.pathname === AUTH_METHODS_PATH && req.method === "GET") return Response.json(authMethods(signIn));
  // Intercept before the stock Hono logger: callback query values include the
  // one-time GitHub code and must never enter request/access logs.
  if (url.pathname === GITHUB_MANIFEST_CALLBACK_PATH && req.method === "GET") {
    return githubManifest.callback(req);
  }
  if (url.pathname.startsWith(`${GITHUB_MANIFEST_PATH}/`) && url.pathname.endsWith("/cancel") && req.method === "POST") {
    const prefix = `${GITHUB_MANIFEST_PATH}/`;
    const tenantId = url.pathname.slice(prefix.length, -"/cancel".length);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      return githubManifest.cancel(req, decodeURIComponent(tenantId));
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (url.pathname.startsWith(`${GITHUB_MANIFEST_PATH}/`) && url.pathname.endsWith("/start") && req.method === "POST") {
    const prefix = `${GITHUB_MANIFEST_PATH}/`;
    const tenantId = url.pathname.slice(prefix.length, -"/start".length);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      return githubManifest.start(req, decodeURIComponent(tenantId));
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (url.pathname.startsWith(`${GITHUB_INSTALLATIONS_PATH}/`) && url.pathname.endsWith("/sync") && req.method === "POST") {
    const tenantId = url.pathname.slice(GITHUB_INSTALLATIONS_PATH.length + 1, -"/sync".length);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    let decoded: string;
    try {
      decoded = decodeURIComponent(tenantId);
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    return syncInstallations(req, decoded);
  }
  if (url.pathname.startsWith(`${GITHUB_PR_ACTIONS_PATH}/`) && req.method === "POST") {
    const tenantId = url.pathname.slice(GITHUB_PR_ACTIONS_PATH.length + 1);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      return githubPrActions(req, decodeURIComponent(tenantId));
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (url.pathname.startsWith(`${GITHUB_PR_TRIAGE_PATH}/`) && req.method === "POST") {
    const tenantId = url.pathname.slice(GITHUB_PR_TRIAGE_PATH.length + 1);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      return githubPrTriage(req, decodeURIComponent(tenantId));
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (url.pathname.startsWith(`${GITHUB_OPEN_PULLS_PATH}/`) && req.method === "GET") {
    const tenantId = url.pathname.slice(GITHUB_OPEN_PULLS_PATH.length + 1);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      return githubOpenPulls(req, decodeURIComponent(tenantId));
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (url.pathname.startsWith(`${GITHUB_PR_DETAILS_PATH}/`) && req.method === "GET") {
    const tenantId = url.pathname.slice(GITHUB_PR_DETAILS_PATH.length + 1);
    if (!tenantId || tenantId.includes("/")) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      return githubPrDetails(req, decodeURIComponent(tenantId));
    } catch {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  }
  if (url.pathname === HOOK_MOUNT_PATH || url.pathname.startsWith(`${HOOK_MOUNT_PATH}/`)) {
    // Fail fast on bodies the stock hook app would reject with 413, before
    // hook lookup, decrypt or HMAC work. The bridge re-checks actual bytes
    // while reading (Content-Length may be missing or dishonest).
    const declared = req.headers.get("content-length");
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      return Response.json({ error: "payload_too_large" }, { status: 413 });
    }
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
      const prepared = await prepareCorbitsTriagePatch(composition.db, tenantId, req);
      if (prepared instanceof Response) return prepared;
      return stock.fetch(prepared, server);
    }
  }
  return stock.fetch(req, server);
}

triageLoop.start();

console.log(JSON.stringify({
  ts: new Date().toISOString(),
  level: "info",
  msg: "hub composition",
  workflows: EXPECTED_DEPLOYMENT_SET.workflows,
  tools: EXPECTED_DEPLOYMENT_SET.tools,
  webhookMount: HOOK_MOUNT_PATH,
}));

export default {
  ...stock,
  fetch: env.PORTAL_ORIGIN === undefined ? routeRequest : withPortalCors(new URL(env.PORTAL_ORIGIN).origin, routeRequest),
};
